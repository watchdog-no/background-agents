import { describe, expect, it, vi, beforeEach } from "vitest";
import { generateInternalToken } from "@open-inspect/shared";
import type { Env } from "./types";
import type * as WebhookHandler from "./webhook-handler";
import {
  createFakeKV,
  makeExecutionContext,
  makeLinearBotEnv,
  signLinearWebhookRequest,
} from "./test-helpers";

const mocks = vi.hoisted(() => ({
  handleAgentSessionEvent: vi.fn(async () => undefined),
}));

vi.mock("./webhook-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof WebhookHandler>();
  return {
    ...actual,
    handleAgentSessionEvent: mocks.handleAgentSessionEvent,
  };
});

const { default: app } = await import("./index");

function createMockKV(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
      };
    }),
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    INTERNAL_CALLBACK_SECRET: "internal-secret",
    LINEAR_KV: createMockKV() as unknown as KVNamespace,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    ...overrides,
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

async function authHeaders(secret = "internal-secret"): Promise<Record<string, string>> {
  const token = await generateInternalToken(secret);
  return { Authorization: `Bearer ${token}` };
}

function freshToken(accessToken: string): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: "refresh",
    expires_at: Date.now() + 60 * 60 * 1000,
  });
}

describe("GET /internal/app-token", () => {
  it("returns 500 when internal auth is not configured", async () => {
    const response = await app.fetch(
      new Request("http://localhost/internal/app-token"),
      makeEnv({ INTERNAL_CALLBACK_SECRET: undefined }),
      makeCtx()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Auth not configured" });
  });

  it("returns 401 for invalid internal auth", async () => {
    const response = await app.fetch(
      new Request("http://localhost/internal/app-token", {
        headers: { Authorization: "Bearer invalid" },
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 404 when no workspace has authorized the app", async () => {
    const response = await app.fetch(
      new Request("http://localhost/internal/app-token", {
        headers: await authHeaders(),
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "no_authorized_workspace" });
  });

  it("returns the app actor token for an authorized workspace", async () => {
    const env = makeEnv({
      LINEAR_KV: createMockKV({
        "oauth:token:org-1": freshToken("app-token"),
      }) as unknown as KVNamespace,
    });

    const response = await app.fetch(
      new Request("http://localhost/internal/app-token", {
        headers: await authHeaders(),
      }),
      env,
      makeCtx()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accessToken: "app-token" });
  });
});

function makeAgentSessionPayload(webhookId = "webhook-config-1") {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    webhookId,
    agentSession: {
      id: "agent-session-1",
      promptContext: "Implement the Linear issue.",
    },
  };
}

async function makeWebhookRequest(payload: unknown, deliveryId?: string): Promise<Request> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "linear-signature": await signLinearWebhookRequest(body),
  };
  if (deliveryId) headers["linear-delivery"] = deliveryId;

  return new Request("http://localhost/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects AgentSessionEvent payloads without Linear-Delivery before dedupe or enqueue", async () => {
    const { kv } = createFakeKV();
    const ctx = makeExecutionContext();

    const res = await app.fetch(
      await makeWebhookRequest(makeAgentSessionPayload()),
      makeLinearBotEnv(kv),
      ctx
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing Linear-Delivery header" });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("deduplicates AgentSessionEvent deliveries by Linear-Delivery header", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const ctx = makeExecutionContext();
    const payload = makeAgentSessionPayload();

    const firstRes = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);
    const duplicateRes = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);

    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    expect(duplicateRes.status).toBe(200);
    expect(await duplicateRes.json()).toEqual({ ok: true, skipped: true, reason: "duplicate" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledOnce();
    expect(putCalls).toEqual([
      { key: "event:delivery-1", value: "1", options: { expirationTtl: 3600 } },
    ]);
  });

  it("does not treat distinct Linear-Delivery headers with the same webhookId as duplicates", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const ctx = makeExecutionContext();
    const payload = makeAgentSessionPayload("stable-webhook-config-id");

    const firstRes = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);
    const secondRes = await app.fetch(await makeWebhookRequest(payload, "delivery-2"), env, ctx);

    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledTimes(2);
    expect(putCalls.map((call) => call.key)).toEqual(["event:delivery-1", "event:delivery-2"]);
  });

  it("rejects malformed AgentSessionEvent payloads before dedupe", async () => {
    const { kv } = createFakeKV();
    const ctx = makeExecutionContext();
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      webhookId: "webhook-config-1",
      agentSession: {},
    };

    const res = await app.fetch(
      await makeWebhookRequest(payload, "delivery-1"),
      makeLinearBotEnv(kv),
      ctx
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid payload" });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });
});
