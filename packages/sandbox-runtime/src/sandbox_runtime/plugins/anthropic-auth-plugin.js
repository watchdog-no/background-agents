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

// In-memory token cache (reset on sandbox restart - fresh refresh via bridge)
let cachedAccessToken = null;
let cachedExpiresAt = 0;

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
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return response.json();
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
  } catch {
    // Non-fatal: the in-memory cache is the source of truth
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

        // Zero out costs for subscription-billed Claude models so the UI shows
        // them as free.
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          };
        }

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

            // Build headers
            const headers = new Headers();
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

            // Append the OAuth beta flag without clobbering any existing value.
            const existingBeta = headers.get("anthropic-beta");
            const betas = existingBeta
              ? existingBeta
                  .split(",")
                  .map((b) => b.trim())
                  .filter(Boolean)
              : [];
            if (!betas.includes(ANTHROPIC_BETA_OAUTH)) betas.push(ANTHROPIC_BETA_OAUTH);
            headers.set("anthropic-beta", betas.join(", "));

            // No URL rewrite — Anthropic OAuth uses the standard Messages API.
            return fetch(requestInput, { ...init, headers });
          },
        };
      },
    },
  };
};
