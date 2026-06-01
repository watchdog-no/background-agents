import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_OAUTH_SANDBOX_FLAG,
  filterSandboxCredentialEnvVars,
  prepareSandboxOAuthEnv,
} from "./oauth-env";

describe("prepareSandboxOAuthEnv", () => {
  it("returns empty env and disabled flag when no env vars are provided", () => {
    expect(prepareSandboxOAuthEnv(undefined)).toEqual({
      userEnvVars: undefined,
      anthropicOauthEnabled: false,
    });
  });

  it("strips Anthropic OAuth token material and derives sandbox flag", () => {
    const result = prepareSandboxOAuthEnv({
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-token",
      ANTHROPIC_OAUTH_ACCESS_TOKEN: "access-token",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "123",
      ANTHROPIC_OAUTH_AUTHORIZE_URL: "https://oauth.example.test/authorize",
      ANTHROPIC_OAUTH_CLIENT_ID: "public-client-id",
      ANTHROPIC_OAUTH_TOKEN_URL: "https://oauth.example.test/token",
      ANTHROPIC_OAUTH_REDIRECT_URI: "https://oauth.example.test/callback",
      ANTHROPIC_OAUTH_SCOPES: "user:inference",
      DATABASE_URL: "postgres://example",
    });

    expect(result).toEqual({
      userEnvVars: { DATABASE_URL: "postgres://example" },
      anthropicOauthEnabled: true,
    });
  });

  it("does not enable Anthropic OAuth for blank refresh tokens", () => {
    const result = prepareSandboxOAuthEnv({
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "  ",
      CUSTOM_VAR: "value",
    });

    expect(result).toEqual({
      userEnvVars: { CUSTOM_VAR: "value" },
      anthropicOauthEnabled: false,
    });
  });

  it("strips user-provided sandbox flag", () => {
    const result = prepareSandboxOAuthEnv({
      [ANTHROPIC_OAUTH_SANDBOX_FLAG]: "true",
      CUSTOM_VAR: "value",
    });

    expect(result).toEqual({
      userEnvVars: { CUSTOM_VAR: "value" },
      anthropicOauthEnabled: false,
    });
  });

  it("filters keys case-insensitively", () => {
    const result = prepareSandboxOAuthEnv({
      anthropic_oauth_refresh_token: "refresh-token",
      anthropic_oauth_access_token: "access-token",
    });

    expect(result).toEqual({
      userEnvVars: undefined,
      anthropicOauthEnabled: true,
    });
  });
});

describe("filterSandboxCredentialEnvVars", () => {
  it("strips Anthropic OAuth keys without deriving setup state", () => {
    expect(
      filterSandboxCredentialEnvVars({
        ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-token",
        ANTHROPIC_OAUTH_ENABLED: "true",
        CUSTOM_VAR: "value",
      })
    ).toEqual({ CUSTOM_VAR: "value" });
  });

  it("strips classifier model API keys so they never reach sandboxes", () => {
    expect(
      filterSandboxCredentialEnvVars({
        ANTHROPIC_API_KEY: "sk-ant-classifier",
        OPENAI_API_KEY: "sk-openai-classifier",
        CUSTOM_VAR: "value",
      })
    ).toEqual({ CUSTOM_VAR: "value" });
  });
});
