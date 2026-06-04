/**
 * Repository classification endpoint.
 *
 * Runs the small "which repo does this issue/message belong to?" LLM call on
 * behalf of the bots (linear-bot, slack-bot), so the call can use the same
 * subscription OAuth credentials the coding agents use — those live as global
 * secrets in this control plane, not in the bots, and classification happens
 * before any session/sandbox exists.
 *
 * Credentials resolve **API-key-first** (fastest — no token-refresh round trip),
 * falling back to the global subscription OAuth token when no key is configured
 * or the stored key is rejected.
 */

import type { Env } from "../types";
import type { ClassifyRawResult, ClassifyErrorReason, ConfidenceLevel } from "@open-inspect/shared";
import {
  extractProviderAndModel,
  CLAUDE_CODE_AGENT_SDK_IDENTITY,
  CLAUDE_CODE_BILLING_HEADER,
  CLAUDE_CODE_MAX_TOKENS,
  CLAUDE_CODE_USER_AGENT,
  ANTHROPIC_OAUTH_BETA,
} from "@open-inspect/shared";
import { createLogger } from "../logger";
import { GlobalSecretsStore } from "../db/global-secrets";
import { OpenAITokenRefreshService } from "../session/openai-token-refresh-service";
import { AnthropicTokenRefreshService } from "../session/anthropic-token-refresh-service";
import { type Route, type RequestContext, parsePattern, json } from "./shared";

const log = createLogger("router:classify");

const CLASSIFY_TOOL_NAME = "classify_repository";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** JSON schema for the structured classification result. */
const CLASSIFY_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    repoId: {
      type: ["string", "null"],
      description: "Repository ID (owner/name) if confident, otherwise null.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reasoning: { type: "string", description: "Brief explanation." },
    alternatives: {
      type: "array",
      items: { type: "string" },
      description: "Alternative repo IDs when not confident.",
    },
  },
  required: ["repoId", "confidence", "reasoning", "alternatives"],
};

const CLASSIFY_TOOL_DESCRIPTION = "Classify which repository an issue belongs to.";

/** A classification failure that maps to a non-2xx response with a reason code. */
class ClassifyError extends Error {
  constructor(
    readonly reason: ClassifyErrorReason,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function normalizeRawResult(input: Record<string, unknown>): ClassifyRawResult {
  const confidence =
    input.confidence === "high" || input.confidence === "medium" || input.confidence === "low"
      ? (input.confidence as ConfidenceLevel)
      : "low";
  return {
    repoId: typeof input.repoId === "string" ? input.repoId : null,
    confidence,
    reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
    alternatives: Array.isArray(input.alternatives)
      ? input.alternatives.filter((a): a is string => typeof a === "string")
      : [],
  };
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

type AnthropicCred = { apiKey: string } | { oauthToken: string };

async function anthropicRequest(
  prompt: string,
  model: string,
  cred: AnthropicCred
): Promise<ClassifyRawResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const body: Record<string, unknown> = {
    model,
    max_tokens: 500,
    temperature: 0,
    tools: [
      {
        name: CLASSIFY_TOOL_NAME,
        description: CLASSIFY_TOOL_DESCRIPTION,
        input_schema: CLASSIFY_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
    messages: [{ role: "user", content: prompt }],
  };

  if ("apiKey" in cred) {
    headers["x-api-key"] = cred.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${cred.oauthToken}`;
    headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    headers["user-agent"] = CLAUDE_CODE_USER_AGENT;
    headers["x-app"] = "cli";
    body.max_tokens = CLAUDE_CODE_MAX_TOKENS;
    body.system = [
      { type: "text", text: CLAUDE_CODE_BILLING_HEADER },
      { type: "text", text: CLAUDE_CODE_AGENT_SDK_IDENTITY },
    ];
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await providerHttpError("anthropic", response);
  }

  const data = (await response.json()) as { content?: AnthropicContentBlock[] };
  const toolBlock = data.content?.find(
    (b) => b.type === "tool_use" && b.name === CLASSIFY_TOOL_NAME
  );
  if (!toolBlock || typeof toolBlock.input !== "object" || toolBlock.input === null) {
    throw new ClassifyError("provider_error", "No tool_use block in Anthropic response", 502);
  }
  return normalizeRawResult(toolBlock.input as Record<string, unknown>);
}

async function classifyWithAnthropic(
  env: Env,
  prompt: string,
  model: string
): Promise<ClassifyRawResult> {
  // Prefer the API key (fastest), but fall back to OAuth if a configured key is
  // rejected — a revoked/blank key shouldn't break classification when an OAuth
  // token is available.
  const apiKey = await readGlobalSecret(env, "ANTHROPIC_API_KEY");
  if (apiKey) {
    try {
      return await anthropicRequest(prompt, model, { apiKey });
    } catch (e) {
      if (!shouldFallbackToOAuth(e, oauthSecretsConfigured(env))) throw e;
      log.warn("classify.api_key_rejected_falling_back_to_oauth", { provider: "anthropic" });
    }
  }
  const oauthToken = await getAnthropicOAuthToken(env);
  return anthropicRequest(prompt, model, { oauthToken });
}

function oauthSecretsConfigured(env: Env): boolean {
  return Boolean(env.DB && env.REPO_SECRETS_ENCRYPTION_KEY);
}

/**
 * Read a single secret from the D1 global secrets store (where the OAuth tokens
 * and the optional model API keys are managed via the Secrets UI). Returns
 * undefined when the store isn't configured, the key is absent, or a read fails.
 */
async function readGlobalSecret(env: Env, key: string): Promise<string | undefined> {
  if (!oauthSecretsConfigured(env)) return undefined;
  try {
    const store = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
    const secrets = await store.getDecryptedSecrets();
    return secrets[key] || undefined;
  } catch (e) {
    log.warn("classify.global_secret_read_failed", {
      key,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/** An auth rejection is recoverable only when an OAuth fallback is available. */
function shouldFallbackToOAuth(e: unknown, oauthAvailable: boolean): boolean {
  return oauthAvailable && e instanceof ClassifyError && e.reason === "oauth_unauthorized";
}

async function getAnthropicOAuthToken(env: Env): Promise<string> {
  if (!env.DB || !env.REPO_SECRETS_ENCRYPTION_KEY) {
    throw new ClassifyError(
      "oauth_not_configured",
      "No ANTHROPIC_API_KEY and OAuth secret store is not configured",
      500
    );
  }
  const oauthConfig =
    env.ANTHROPIC_OAUTH_CLIENT_ID || env.ANTHROPIC_OAUTH_TOKEN_URL
      ? { clientId: env.ANTHROPIC_OAUTH_CLIENT_ID, tokenUrl: env.ANTHROPIC_OAUTH_TOKEN_URL }
      : undefined;
  const service = new AnthropicTokenRefreshService(
    env.DB,
    env.REPO_SECRETS_ENCRYPTION_KEY,
    refreshRepoIdUnsupported,
    log,
    oauthConfig
  );
  const result = await service.refreshGlobal();
  if (!result.ok) {
    throw oauthRefreshError(result.status);
  }
  return result.accessToken;
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

interface OpenAIResponsesOutputItem {
  type: string;
  name?: string;
  arguments?: string;
}

type OpenAICred = { apiKey: string } | { oauthToken: string; accountId?: string };

async function openaiRequest(
  prompt: string,
  model: string,
  cred: OpenAICred
): Promise<ClassifyRawResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;

  if ("apiKey" in cred) {
    headers["Authorization"] = `Bearer ${cred.apiKey}`;
    url = OPENAI_RESPONSES_URL;
  } else {
    headers["Authorization"] = `Bearer ${cred.oauthToken}`;
    if (cred.accountId) headers["ChatGPT-Account-Id"] = cred.accountId;
    headers["originator"] = "opencode";
    headers["session_id"] = crypto.randomUUID();
    url = OPENAI_CODEX_RESPONSES_URL;
  }

  const body = {
    model,
    input: prompt,
    tools: [
      {
        type: "function",
        name: CLASSIFY_TOOL_NAME,
        description: CLASSIFY_TOOL_DESCRIPTION,
        parameters: CLASSIFY_INPUT_SCHEMA,
        strict: false,
      },
    ],
    tool_choice: { type: "function", name: CLASSIFY_TOOL_NAME },
    // No max_output_tokens: reasoning/codex models spend output tokens on
    // reasoning before the (small) forced function call — a tight cap truncates
    // them. The forced single tool call keeps the response short regardless.
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await providerHttpError("openai", response);
  }

  const data = (await response.json()) as { output?: OpenAIResponsesOutputItem[] };
  const call = data.output?.find(
    (item) => item.type === "function_call" && item.name === CLASSIFY_TOOL_NAME
  );
  if (!call?.arguments) {
    throw new ClassifyError("provider_error", "No function_call in OpenAI response", 502);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    throw new ClassifyError("provider_error", "OpenAI function_call arguments were not JSON", 502);
  }
  return normalizeRawResult(parsed);
}

async function classifyWithOpenAI(
  env: Env,
  prompt: string,
  model: string
): Promise<ClassifyRawResult> {
  const oauthAvailable = oauthSecretsConfigured(env);

  const apiKey = await readGlobalSecret(env, "OPENAI_API_KEY");
  if (apiKey) {
    try {
      return await openaiRequest(prompt, model, { apiKey });
    } catch (e) {
      if (!shouldFallbackToOAuth(e, oauthAvailable)) throw e;
      log.warn("classify.api_key_rejected_falling_back_to_oauth", { provider: "openai" });
    }
  }

  const { accessToken, accountId } = await getOpenAIOAuthToken(env);
  return openaiRequest(prompt, model, { oauthToken: accessToken, accountId });
}

async function getOpenAIOAuthToken(env: Env): Promise<{ accessToken: string; accountId?: string }> {
  if (!env.DB || !env.REPO_SECRETS_ENCRYPTION_KEY) {
    throw new ClassifyError(
      "oauth_not_configured",
      "No OPENAI_API_KEY and OAuth secret store is not configured",
      500
    );
  }
  const service = new OpenAITokenRefreshService(
    env.DB,
    env.REPO_SECRETS_ENCRYPTION_KEY,
    refreshRepoIdUnsupported,
    log
  );
  const result = await service.refreshGlobal();
  if (!result.ok) {
    throw oauthRefreshError(result.status);
  }
  return { accessToken: result.accessToken, accountId: result.accountId };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** The global-only refresh path never resolves a repo id; guard against misuse. */
const refreshRepoIdUnsupported = (): Promise<number> => {
  throw new Error("Global token refresh does not resolve a repo id");
};

function oauthRefreshError(status: number): ClassifyError {
  if (status === 404) {
    return new ClassifyError("oauth_not_configured", "OAuth refresh token not configured", 500);
  }
  if (status === 401) {
    return new ClassifyError("oauth_unauthorized", "OAuth refresh token rejected", 502);
  }
  return new ClassifyError("provider_error", "OAuth token refresh failed", 502);
}

async function providerHttpError(provider: string, response: Response): Promise<ClassifyError> {
  const text = await response.text().catch(() => "");
  // 401/403 against the model API usually means the credential is bad/unauthorized.
  const reason: ClassifyErrorReason =
    response.status === 401 || response.status === 403 ? "oauth_unauthorized" : "provider_error";
  return new ClassifyError(
    reason,
    `${provider} API error ${response.status}: ${text.slice(0, 200)}`,
    502
  );
}

// ─── Route handler ─────────────────────────────────────────────────────────────

async function handleClassify(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  let payload: { prompt?: unknown; model?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return classifyErrorResponse(
      new ClassifyError("invalid_request", "Request body must be JSON", 400)
    );
  }

  const prompt = payload.prompt;
  const model = payload.model;
  if (typeof prompt !== "string" || prompt.length === 0 || typeof model !== "string") {
    return classifyErrorResponse(
      new ClassifyError("invalid_request", "Both `prompt` and `model` are required", 400)
    );
  }

  const { provider, model: modelId } = extractProviderAndModel(model);

  try {
    const result =
      provider === "openai"
        ? await classifyWithOpenAI(env, prompt, modelId)
        : await classifyWithAnthropic(env, prompt, modelId);
    return json(result);
  } catch (e) {
    if (e instanceof ClassifyError) {
      log.warn("classify.failed", {
        trace_id: ctx.trace_id,
        provider,
        model: modelId,
        reason: e.reason,
        error_message: e.message,
      });
      return classifyErrorResponse(e);
    }
    log.error("classify.unexpected_error", {
      trace_id: ctx.trace_id,
      provider,
      model: modelId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return classifyErrorResponse(new ClassifyError("provider_error", "Classification failed", 502));
  }
}

function classifyErrorResponse(e: ClassifyError): Response {
  return json({ reason: e.reason, message: e.message }, e.status);
}

export const classifyRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/classify"),
    handler: handleClassify,
  },
];
