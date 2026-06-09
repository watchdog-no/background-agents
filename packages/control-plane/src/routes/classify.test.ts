import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_OAUTH_BETA,
  CLAUDE_CODE_AGENT_SDK_IDENTITY,
  CLAUDE_CODE_BILLING_HEADER,
  CLAUDE_CODE_MAX_TOKENS,
  CLAUDE_CODE_USER_AGENT,
} from "@open-inspect/shared";
import type { Env } from "../types";
import type { RequestContext } from "./shared";

const { mockOpenAIRefreshGlobal, mockAnthropicRefreshGlobal, mockGetDecryptedSecrets } = vi.hoisted(
  () => ({
    mockOpenAIRefreshGlobal: vi.fn(),
    mockAnthropicRefreshGlobal: vi.fn(),
    mockGetDecryptedSecrets: vi.fn(),
  })
);

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: vi.fn().mockImplementation(function () {
    return { getDecryptedSecrets: mockGetDecryptedSecrets };
  }),
}));

vi.mock("../session/openai-token-refresh-service", () => ({
  OpenAITokenRefreshService: vi.fn().mockImplementation(function () {
    return { refreshGlobal: mockOpenAIRefreshGlobal };
  }),
}));

vi.mock("../session/anthropic-token-refresh-service", () => ({
  AnthropicTokenRefreshService: vi.fn().mockImplementation(function () {
    return { refreshGlobal: mockAnthropicRefreshGlobal };
  }),
}));

import { classifyRoutes } from "./classify";

const handler = classifyRoutes[0].handler;
const ctx = { trace_id: "test-trace" } as unknown as RequestContext;
const mockFetch = vi.fn();

// Every real deployment that can read API keys from global secrets can also do
// OAuth (both need DB + REPO_SECRETS_ENCRYPTION_KEY).
const ENV = { DB: {}, REPO_SECRETS_ENCRYPTION_KEY: "enc" } as unknown as Env;

const VALID_RESULT = {
  repoId: "acme/web",
  confidence: "high",
  reasoning: "Mentions the web UI.",
  alternatives: [],
};

function anthropicToolResponse(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "tool_use", name: "classify_repository", input: VALID_RESULT }],
    }),
    { status: 200 }
  );
}

function openaiFunctionResponse(): Response {
  return new Response(
    JSON.stringify({
      output: [
        {
          type: "function_call",
          name: "classify_repository",
          arguments: JSON.stringify(VALID_RESULT),
        },
      ],
    }),
    { status: 200 }
  );
}

function request(body: unknown): Request {
  return new Request("https://internal/classify", { method: "POST", body: JSON.stringify(body) });
}

function lastFetch(): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return {
    url: String(url),
    headers: (init.headers ?? {}) as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}

function classify(model: string, env: Env = ENV) {
  return handler(
    request({ prompt: "which repo?", model }),
    env,
    [] as unknown as RegExpMatchArray,
    ctx
  );
}

function expectAnthropicOAuthEnvelope(call: ReturnType<typeof lastFetch>) {
  expect(call.headers["Authorization"]).toBe("Bearer oauth-token");
  expect(call.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
  expect(call.headers["anthropic-beta"]).toContain("claude-code-20250219");
  expect(call.headers["anthropic-beta"]).toContain("extended-cache-ttl-2025-04-11");
  expect(call.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(call.headers["user-agent"]).toBe(CLAUDE_CODE_USER_AGENT);
  expect(call.headers["x-app"]).toBe("cli");
  expect(call.body.max_tokens).toBe(CLAUDE_CODE_MAX_TOKENS);
  const system = call.body.system as Array<{ type: string; text: string }>;
  expect(system[0].text).toBe(CLAUDE_CODE_BILLING_HEADER);
  expect(system[1].text).toBe(CLAUDE_CODE_AGENT_SDK_IDENTITY);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockGetDecryptedSecrets.mockResolvedValue({}); // no API keys by default → OAuth path
});

describe("POST /classify", () => {
  it("uses an Anthropic API key from global secrets directly (no identity injection)", async () => {
    mockGetDecryptedSecrets.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-test" });
    mockFetch.mockResolvedValue(anthropicToolResponse());

    const res = await classify("anthropic/claude-haiku-4-5");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_RESULT);
    const call = lastFetch();
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call.headers["Authorization"]).toBeUndefined();
    expect(call.body.system).toBeUndefined();
    expect(mockAnthropicRefreshGlobal).not.toHaveBeenCalled();
  });

  it("uses Anthropic OAuth with the Claude Code envelope when no API key is stored", async () => {
    mockAnthropicRefreshGlobal.mockResolvedValue({ ok: true, accessToken: "oauth-token" });
    mockFetch.mockResolvedValue(anthropicToolResponse());

    const res = await classify("anthropic/claude-haiku-4-5");

    expect(res.status).toBe(200);
    const call = lastFetch();
    expectAnthropicOAuthEnvelope(call);
  });

  it("falls back to Anthropic OAuth when a stored API key is rejected", async () => {
    mockGetDecryptedSecrets.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-ant-revoked" });
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad key" }), { status: 401 }))
      .mockResolvedValueOnce(anthropicToolResponse());
    mockAnthropicRefreshGlobal.mockResolvedValue({ ok: true, accessToken: "oauth-token" });

    const res = await classify("anthropic/claude-haiku-4-5");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_RESULT);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const fallback = lastFetch();
    expectAnthropicOAuthEnvelope(fallback);
  });

  it("uses an OpenAI API key from global secrets against the platform Responses API", async () => {
    mockGetDecryptedSecrets.mockResolvedValue({ OPENAI_API_KEY: "sk-openai" });
    mockFetch.mockResolvedValue(openaiFunctionResponse());

    const res = await classify("openai/gpt-5.4-nano");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_RESULT);
    const call = lastFetch();
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.headers["Authorization"]).toBe("Bearer sk-openai");
  });

  it("falls back to OpenAI OAuth when a stored API key is rejected", async () => {
    mockGetDecryptedSecrets.mockResolvedValue({ OPENAI_API_KEY: "sk-openai-bad" });
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad key" }), { status: 401 }))
      .mockResolvedValueOnce(openaiFunctionResponse());
    mockOpenAIRefreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "codex-token",
      accountId: "acct-123",
    });

    const res = await classify("openai/gpt-5.4-mini");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VALID_RESULT);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const fallback = lastFetch();
    expect(fallback.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(fallback.headers["Authorization"]).toBe("Bearer codex-token");
    expect(fallback.headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(fallback.body.model).toBe("gpt-5.4-mini");
  });

  it("falls back to OpenAI OAuth against the Codex backend with account headers", async () => {
    mockOpenAIRefreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "codex-token",
      accountId: "acct-123",
    });
    mockFetch.mockResolvedValue(openaiFunctionResponse());

    const res = await classify("openai/gpt-5.4-mini");

    expect(res.status).toBe(200);
    const call = lastFetch();
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.headers["Authorization"]).toBe("Bearer codex-token");
    expect(call.headers["ChatGPT-Account-Id"]).toBe("acct-123");
    expect(call.headers["originator"]).toBe("opencode");
    expect(call.body.model).toBe("gpt-5.4-mini");
  });

  it("lets the Codex backend decide unsupported OpenAI OAuth models", async () => {
    mockOpenAIRefreshGlobal.mockResolvedValue({ ok: true, accessToken: "codex-token" });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "unsupported model" } }), { status: 400 })
    );

    const res = await classify("openai/gpt-5.4-nano");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "provider_error" });
    const call = lastFetch();
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.body.model).toBe("gpt-5.4-nano");
  });

  it("surfaces an OAuth-unauthorized failure with a reason code", async () => {
    mockAnthropicRefreshGlobal.mockResolvedValue({ ok: false, status: 401, error: "nope" });

    const res = await classify("anthropic/claude-haiku-4-5");

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ reason: "oauth_unauthorized" });
  });

  it("rejects an invalid request body", async () => {
    const res = await handler(
      request({ model: "anthropic/claude-haiku-4-5" }),
      {} as unknown as Env,
      [] as unknown as RegExpMatchArray,
      ctx
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid_request" });
  });
});
