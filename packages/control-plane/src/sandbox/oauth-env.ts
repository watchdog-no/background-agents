const ANTHROPIC_OAUTH_REFRESH_TOKEN_KEY = "ANTHROPIC_OAUTH_REFRESH_TOKEN";

export const ANTHROPIC_OAUTH_SANDBOX_FLAG = "ANTHROPIC_OAUTH_ENABLED";

// Global-secret keys that must not be injected into sandbox sessions: OAuth
// token/config material, plus provider API keys that coding agents could
// auto-detect and use instead of the intended subscription OAuth path.
const SANDBOX_FILTERED_CREDENTIAL_KEYS = new Set([
  ANTHROPIC_OAUTH_REFRESH_TOKEN_KEY,
  "ANTHROPIC_OAUTH_ACCESS_TOKEN",
  "ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  ANTHROPIC_OAUTH_SANDBOX_FLAG,
  "ANTHROPIC_OAUTH_AUTHORIZE_URL",
  "ANTHROPIC_OAUTH_CLIENT_ID",
  "ANTHROPIC_OAUTH_TOKEN_URL",
  "ANTHROPIC_OAUTH_REDIRECT_URI",
  "ANTHROPIC_OAUTH_SCOPES",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

export interface PreparedSandboxOAuthEnv {
  userEnvVars: Record<string, string> | undefined;
  anthropicOauthEnabled: boolean;
}

export function filterSandboxCredentialEnvVars(
  userEnvVars: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!userEnvVars) {
    return undefined;
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(userEnvVars)) {
    if (!SANDBOX_FILTERED_CREDENTIAL_KEYS.has(key.toUpperCase())) {
      filtered[key] = value;
    }
  }

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function prepareSandboxOAuthEnv(
  userEnvVars: Record<string, string> | undefined
): PreparedSandboxOAuthEnv {
  if (!userEnvVars) {
    return { userEnvVars: undefined, anthropicOauthEnabled: false };
  }

  let anthropicOauthEnabled = false;

  for (const [key, value] of Object.entries(userEnvVars)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === ANTHROPIC_OAUTH_REFRESH_TOKEN_KEY) {
      anthropicOauthEnabled = anthropicOauthEnabled || value.trim().length > 0;
    }
  }

  return {
    userEnvVars: filterSandboxCredentialEnvVars(userEnvVars),
    anthropicOauthEnabled,
  };
}
