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

// Claude Pro/Max OAuth tokens are only authorized for Claude Code. Anthropic
// rejects requests whose first system block is not this exact identity, and the
// rejection arrives as a generic `429 {"type":"rate_limit_error"}` with NO
// `anthropic-ratelimit-*` headers — easily mistaken for a usage cap. Prepend the
// identity so the subscription request is accepted, mirroring the upstream
// Claude Code client (OpenCode has no native Anthropic OAuth, so this plugin
// owns the whole request).
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// OpenCode's built-in system prompt opens by asserting a competing agent
// identity. We replace just that opening sentence with a neutral operational
// note so the model sees ONE coherent identity (Claude Code) running via the
// OpenCode harness, while keeping the rest of OpenCode's prompt — tool rules,
// formatting, safety — untouched. Matched as an exact prefix, so it is a no-op
// if OpenCode changes the wording in a future version (we then fall back to the
// harmless dual identity rather than breaking).
const OPENCODE_IDENTITY_PREFIX = "You are OpenCode, the best coding agent on the planet.";
const OPENCODE_HARNESS_NOTE = "You are running through the OpenCode harness.";

function rewriteOpenCodeIdentity(text) {
  if (typeof text === "string" && text.startsWith(OPENCODE_IDENTITY_PREFIX)) {
    return OPENCODE_HARNESS_NOTE + text.slice(OPENCODE_IDENTITY_PREFIX.length);
  }
  return text;
}

/**
 * Shape the request body for Claude Pro/Max OAuth: make the first `system` block
 * the Claude Code identity (the authorization marker) and demote OpenCode's
 * competing identity sentence to a neutral harness note. Returns the rewritten
 * body string, or the original input if it is not JSON we recognise. A body
 * whose first block is already the identity is left untouched so we never add a
 * duplicate or shift cache breakpoints needlessly.
 */
function rewriteClaudeCodeSystemPromptText(body) {
  if (typeof body !== "string") return body;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  const identityBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };
  const system = parsed.system;

  if (Array.isArray(system)) {
    if (system[0]?.type === "text" && system[0]?.text === CLAUDE_CODE_IDENTITY) return body;
    const rest = system.map((b, i) =>
      i === 0 && b?.type === "text" ? { ...b, text: rewriteOpenCodeIdentity(b.text) } : b
    );
    parsed.system = [identityBlock, ...rest];
  } else if (typeof system === "string") {
    if (system.startsWith(CLAUDE_CODE_IDENTITY)) return body;
    parsed.system = [identityBlock, { type: "text", text: rewriteOpenCodeIdentity(system) }];
  } else {
    parsed.system = [identityBlock];
  }

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
    return text === null ? init.body : rewriteClaudeCodeSystemPromptText(text);
  }

  if (typeof Request !== "undefined" && requestInput instanceof Request && requestInput.body) {
    return rewriteClaudeCodeSystemPromptText(await requestInput.clone().text());
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

            // Append the Claude Code OAuth beta flags without clobbering any existing value.
            const existingBeta = headers.get("anthropic-beta");
            const betas = existingBeta
              ? existingBeta
                  .split(",")
                  .map((b) => b.trim())
                  .filter(Boolean)
              : [];
            if (!betas.includes(ANTHROPIC_BETA_OAUTH)) betas.push(ANTHROPIC_BETA_OAUTH);
            if (!betas.includes(ANTHROPIC_BETA_CLAUDE_CODE)) {
              betas.push(ANTHROPIC_BETA_CLAUDE_CODE);
            }
            headers.set("anthropic-beta", betas.join(", "));

            // Anthropic OAuth (Pro/Max) only authorises Claude Code requests, so
            // the first system block must be the Claude Code identity or the call
            // is rejected with a misleading 429. No URL rewrite — OAuth uses the
            // standard Messages API.
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
