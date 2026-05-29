/**
 * Anthropic OAuth token refresh utilities.
 */

export const DEFAULT_ANTHROPIC_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface AnthropicOAuthConfig {
  /**
   * Public OAuth client ID. Defaults to the Claude Code-compatible public PKCE
   * client used by our internal subscription-auth flow.
   */
  clientId?: string;
  tokenUrl?: string;
}

export interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export class AnthropicTokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
  }
}

/**
 * Refresh an Anthropic OAuth access token using a refresh token.
 */
export async function refreshAnthropicToken(
  refreshToken: string,
  config: AnthropicOAuthConfig = {}
): Promise<AnthropicTokenResponse> {
  const tokenUrl = config.tokenUrl?.trim() || DEFAULT_ANTHROPIC_OAUTH_TOKEN_URL;
  const clientId = config.clientId?.trim() || DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AnthropicTokenRefreshError(
      `Anthropic token refresh failed: ${response.status}`,
      response.status,
      body
    );
  }

  return response.json() as Promise<AnthropicTokenResponse>;
}
