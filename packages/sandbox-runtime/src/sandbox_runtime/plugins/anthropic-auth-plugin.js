/**
 * Anthropic Auth Proxy Plugin for Open-Inspect.
 *
 * Overrides the built-in Anthropic provider to delegate token refresh to the
 * control plane instead of calling Anthropic directly. This ensures rotating
 * refresh tokens are persisted centrally in D1 rather than being lost when
 * ephemeral sandboxes terminate.
 *
 * Auto-loaded from .opencode/plugins/ - OpenCode discovers project plugins
 * and deduplicates by provider ID (last wins), so this replaces the built-in.
 */

const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key";
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry
const ANTHROPIC_BETA_OAUTH = "oauth-2025-04-20";
const ANTHROPIC_BETA_CLAUDE_CODE = "claude-code-20250219";
const ANTHROPIC_BETA_CLAUDE_CODE_SDK = [
  ANTHROPIC_BETA_CLAUDE_CODE,
  ANTHROPIC_BETA_OAUTH,
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
];

const CLAUDE_CODE_CLIENT_VERSION = "2.1.162";
const CLAUDE_CODE_MAX_TOKENS = 64000;
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_CLIENT_VERSION} (external, sdk-cli)`;
const CLAUDE_CODE_BILLING_HEADER =
  `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_CLIENT_VERSION}.518; ` +
  "cc_entrypoint=sdk-cli; cch=00000;";
const CLAUDE_CODE_AGENT_SDK_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const LEGACY_CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function systemToBlocks(system) {
  if (Array.isArray(system)) return system;
  if (typeof system === "string") return [{ type: "text", text: system }];
  return [];
}

function stripExistingClaudeCodeEnvelope(systemBlocks) {
  const blocks = [...systemBlocks];

  while (
    blocks[0]?.type === "text" &&
    typeof blocks[0].text === "string" &&
    blocks[0].text.startsWith("x-anthropic-billing-header:")
  ) {
    blocks.shift();
  }

  while (
    blocks[0]?.type === "text" &&
    (blocks[0].text === CLAUDE_CODE_AGENT_SDK_IDENTITY ||
      blocks[0].text === LEGACY_CLAUDE_CODE_IDENTITY)
  ) {
    blocks.shift();
  }

  return blocks;
}

/**
 * Shape the request body for Claude Pro/Max OAuth by wrapping OpenCode's request
 * in the same SDK-level Claude Code attribution envelope sent by the official
 * Claude Code client. Do not strip OpenCode's prompt or tools: live replay showed
 * the original OpenCode request, including TodoWrite, routes through subscription
 * once this envelope and the matching headers are present.
 */
function rewriteClaudeCodeRequestBodyText(body) {
  if (typeof body !== "string") return body;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  parsed.system = [
    { type: "text", text: CLAUDE_CODE_BILLING_HEADER },
    { type: "text", text: CLAUDE_CODE_AGENT_SDK_IDENTITY },
    ...stripExistingClaudeCodeEnvelope(systemToBlocks(parsed.system)),
  ];

  parsed.max_tokens = CLAUDE_CODE_MAX_TOKENS;

  return JSON.stringify(parsed);
}

async function bodyToText(body) {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    );
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    return body.toString();
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return new Response(body).text();
  }
  return null;
}

async function ensureClaudeCodeSystemPromptBody(requestInput, init) {
  if (init && Object.hasOwn(init, "body")) {
    if (init.body === undefined || init.body === null) return init.body;
    const text = await bodyToText(init.body);
    return text === null ? init.body : rewriteClaudeCodeRequestBodyText(text);
  }

  if (typeof Request !== "undefined" && requestInput instanceof Request && requestInput.body) {
    return rewriteClaudeCodeRequestBodyText(await requestInput.clone().text());
  }

  return undefined;
}

// In-memory token cache (reset on sandbox restart - fresh refresh via bridge)
let cachedAccessToken = null;
let cachedExpiresAt = 0;

function zeroCost(cost = {}) {
  const cache = cost.cache && typeof cost.cache === "object" ? cost.cache : {};
  const base = {
    ...cost,
    input: 0,
    output: 0,
    cache: { ...cache, read: 0, write: 0 },
  };

  if (Array.isArray(cost.tiers)) {
    base.tiers = cost.tiers.map((tierCost) => ({
      ...tierCost,
      input: 0,
      output: 0,
      cache: {
        ...(tierCost.cache && typeof tierCost.cache === "object" ? tierCost.cache : {}),
        read: 0,
        write: 0,
      },
    }));
  }

  if (cost.experimentalOver200K) {
    base.experimentalOver200K = zeroCost(cost.experimentalOver200K);
  }

  return base;
}

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}");
    return config.sessionId || config.session_id || "";
  } catch {
    return "";
  }
}

async function refreshViaControlPlane() {
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
  const authToken = process.env.SANDBOX_AUTH_TOKEN;
  const sessionId = getSessionId();

  if (!controlPlaneUrl || !authToken || !sessionId) {
    throw new Error(
      "Missing environment for token refresh: " +
        [
          !controlPlaneUrl && "CONTROL_PLANE_URL",
          !authToken && "SANDBOX_AUTH_TOKEN",
          !sessionId && "SESSION_CONFIG.sessionId",
        ]
          .filter(Boolean)
          .join(", ")
    );
  }

  const response = await fetch(`${controlPlaneUrl}/sessions/${sessionId}/anthropic-token-refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(formatRefreshError(response.status, body));
  }

  return response.json();
}

function formatRefreshError(status, body) {
  if (status === 404) {
    return `Anthropic OAuth is not configured for this repository or globally (${status}): ${body}`;
  }

  if (status === 400 || status === 401) {
    return `Anthropic OAuth refresh token was rejected; re-run the Anthropic OAuth login script (${status}): ${body}`;
  }

  if (status >= 500) {
    return `Anthropic OAuth token refresh is temporarily unavailable (${status}): ${body}`;
  }

  return `Anthropic OAuth token refresh failed (${status}): ${body}`;
}

async function ensureAccessToken(getAuth, setAuth) {
  const now = Date.now();

  // Return cached token if still fresh
  if (cachedAccessToken && cachedExpiresAt - now > REFRESH_BUFFER_MS) {
    return { accessToken: cachedAccessToken };
  }

  // Refresh via control plane
  const result = await refreshViaControlPlane();

  cachedAccessToken = result.access_token;
  // Anchor expiry to token-receipt time (after the await), not invocation time,
  // so request latency isn't subtracted from the token's lifetime.
  cachedExpiresAt = Date.now() + (result.expires_in ?? 3600) * 1000;

  // Update OpenCode's auth state for consistency
  try {
    const currentAuth = await getAuth();
    await setAuth({
      type: "oauth",
      refresh: currentAuth?.refresh || "managed-by-control-plane",
      access: result.access_token,
      expires: cachedExpiresAt,
    });
  } catch (err) {
    // Non-fatal: the in-memory cache is the source of truth
    console.warn("anthropic_oauth.set_auth_failed", err);
  }

  return { accessToken: cachedAccessToken };
}

export const AnthropicAuthProxy = async (input) => {
  return {
    auth: {
      provider: "anthropic",
      methods: [],
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        const setAuth = async (body) => {
          await input.client.auth.set({ path: { id: "anthropic" }, body });
        };

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput, init) {
            // Remove the dummy API key headers (both x-api-key and any
            // authorization) so they cannot leak alongside the OAuth token.
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization");
                init.headers.delete("Authorization");
                init.headers.delete("x-api-key");
                init.headers.delete("X-Api-Key");
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(([key]) => {
                  const lower = key.toLowerCase();
                  return lower !== "authorization" && lower !== "x-api-key";
                });
              } else {
                delete init.headers["authorization"];
                delete init.headers["Authorization"];
                delete init.headers["x-api-key"];
                delete init.headers["X-Api-Key"];
              }
            }

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth") return fetch(requestInput, init);

            // Ensure we have a valid access token
            const { accessToken } = await ensureAccessToken(getAuth, setAuth);

            // Build headers. If the caller passed a Request, preserve its
            // headers before applying any init.headers overrides.
            const headers =
              typeof Request !== "undefined" && requestInput instanceof Request
                ? new Headers(requestInput.headers)
                : new Headers();
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value));
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value));
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value));
                }
              }
            }

            // Drop the API-key header — OAuth requests must not carry x-api-key.
            headers.delete("x-api-key");

            // Set real authorization
            headers.set("authorization", `Bearer ${accessToken}`);

            // Match the official Claude Code SDK transport markers. The
            // subscription router keys off the request envelope, not OpenCode's
            // prompt content.
            const existingBeta = headers.get("anthropic-beta");
            const betas = existingBeta
              ? existingBeta
                  .split(",")
                  .map((b) => b.trim())
                  .filter(Boolean)
              : [];
            for (const beta of ANTHROPIC_BETA_CLAUDE_CODE_SDK) {
              if (!betas.includes(beta)) betas.push(beta);
            }
            headers.set("anthropic-beta", betas.join(", "));
            if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
            headers.set("anthropic-dangerous-direct-browser-access", "true");
            headers.set("user-agent", CLAUDE_CODE_USER_AGENT);
            headers.set("x-app", "cli");
            const sessionId = getSessionId();
            if (sessionId) headers.set("x-claude-code-session-id", sessionId);

            // No URL rewrite — OAuth uses the standard Messages API.
            const body = await ensureClaudeCodeSystemPromptBody(requestInput, init);
            const nextInit = { ...init, headers };
            headers.delete("content-length");
            if (body !== undefined) nextInit.body = body;
            return fetch(requestInput, nextInit);
          },
        };
      },
    },
    provider: {
      id: "anthropic",
      async models(provider, ctx) {
        if (ctx?.auth && ctx.auth.type !== "oauth") return provider.models;
        const models = provider.models ?? {};

        return Object.fromEntries(
          Object.entries(models).map(([modelId, model]) => [
            modelId,
            {
              ...model,
              cost: zeroCost(model.cost),
            },
          ])
        );
      },
    },
  };
};
