import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { Env } from "../types";
import type { SessionRow } from "./types";
import { AnthropicTokenRefreshService } from "./anthropic-token-refresh-service";
import { AnthropicTokenRefreshError } from "../auth/anthropic";

const mockState = vi.hoisted(() => ({
  repoSecrets: new Map<number, Record<string, string>>(),
  globalSecrets: {} as Record<string, string>,
  refreshImpl: vi.fn(),
  repoWrites: [] as Array<{
    repoId: number;
    owner: string;
    name: string;
    secrets: Record<string, string>;
  }>,
  repoWriteAttempts: [] as Array<{
    repoId: number;
    owner: string;
    name: string;
    secrets: Record<string, string>;
  }>,
  globalWrites: [] as Array<Record<string, string>>,
  globalWriteAttempts: [] as Array<Record<string, string>>,
  failRepoWritesForKeys: new Set<string>(),
  failGlobalWritesForKeys: new Set<string>(),
}));

vi.mock("../auth/anthropic", () => {
  class MockAnthropicTokenRefreshError extends Error {
    status: number;
    body: string;
    constructor(message: string, status: number, body: string) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  return {
    AnthropicTokenRefreshError: MockAnthropicTokenRefreshError,
    refreshAnthropicToken: (refreshToken: string, config?: unknown) =>
      config === undefined
        ? mockState.refreshImpl(refreshToken)
        : mockState.refreshImpl(refreshToken, config),
  };
});

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
      return mockState.repoSecrets.get(repoId) ?? {};
    }

    async setSecrets(
      repoId: number,
      owner: string,
      name: string,
      secrets: Record<string, string>
    ): Promise<void> {
      mockState.repoWriteAttempts.push({ repoId, owner, name, secrets });
      if (Object.keys(secrets).some((key) => mockState.failRepoWritesForKeys.has(key))) {
        throw new Error("repo write failed");
      }
      mockState.repoWrites.push({ repoId, owner, name, secrets });
      const existing = mockState.repoSecrets.get(repoId) ?? {};
      mockState.repoSecrets.set(repoId, { ...existing, ...secrets });
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets(): Promise<Record<string, string>> {
      return mockState.globalSecrets;
    }

    async setSecrets(secrets: Record<string, string>): Promise<void> {
      mockState.globalWriteAttempts.push(secrets);
      if (Object.keys(secrets).some((key) => mockState.failGlobalWritesForKeys.has(key))) {
        throw new Error("global write failed");
      }
      mockState.globalWrites.push(secrets);
      mockState.globalSecrets = { ...mockState.globalSecrets, ...secrets };
    }
  },
}));

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-name-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-opus-4-7",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    context_tokens: 0,
    context_limit: 0,
    sandbox_settings: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

describe("AnthropicTokenRefreshService", () => {
  beforeEach(() => {
    mockState.repoSecrets.clear();
    mockState.globalSecrets = {};
    mockState.repoWrites = [];
    mockState.repoWriteAttempts = [];
    mockState.globalWrites = [];
    mockState.globalWriteAttempts = [];
    mockState.failRepoWritesForKeys.clear();
    mockState.failGlobalWritesForKeys.clear();
    mockState.refreshImpl.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached repo access token when it is still valid", async () => {
    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-1",
      ANTHROPIC_OAUTH_ACCESS_TOKEN: "cached-access",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: true,
      accessToken: "cached-access",
      expiresIn: expect.any(Number),
    });
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
  });

  it("returns 404 when refresh token is missing in repo and global secrets", async () => {
    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => 123,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "ANTHROPIC_OAUTH_REFRESH_TOKEN not configured",
    });
  });

  it("refreshes token and persists rotated credentials to repo secrets", async () => {
    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-old",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.refreshImpl.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 1800,
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: true,
      accessToken: "access-new",
      expiresIn: 1800,
    });
    expect(mockState.refreshImpl).toHaveBeenCalledWith("refresh-old");
    expect(mockState.repoWrites).toHaveLength(2);
    expect(mockState.repoWrites[0].repoId).toBe(repoId);
    expect(mockState.repoWrites[0].owner).toBe("acme");
    expect(mockState.repoWrites[0].name).toBe("web");
    expect(mockState.repoWrites[0].secrets.ANTHROPIC_OAUTH_REFRESH_TOKEN).toBe("refresh-new");
    expect(mockState.repoWrites[0].secrets.ANTHROPIC_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(mockState.repoWrites[1].secrets.ANTHROPIC_OAUTH_ACCESS_TOKEN).toBe("access-new");
  });

  it("passes configured OAuth client settings to token refresh", async () => {
    const repoId = 123;
    const oauthConfig = {
      clientId: "custom-client-id",
      tokenUrl: "https://oauth.example.test/token",
    };
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-old",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.refreshImpl.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 1800,
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger(),
      oauthConfig
    );

    await service.refresh(createSession());

    expect(mockState.refreshImpl).toHaveBeenCalledWith("refresh-old", oauthConfig);
  });

  it("falls back to global refresh token when repo token is missing", async () => {
    const repoId = 123;
    mockState.globalSecrets = {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockResolvedValue({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: true,
      accessToken: "global-access-new",
      expiresIn: 1800,
    });
    expect(mockState.refreshImpl).toHaveBeenCalledWith("global-refresh-old");
    expect(mockState.repoWrites).toHaveLength(0);
    expect(mockState.globalWrites).toHaveLength(2);
    expect(mockState.globalWrites[0].ANTHROPIC_OAUTH_REFRESH_TOKEN).toBe("global-refresh-new");
    expect(mockState.globalWrites[1].ANTHROPIC_OAUTH_ACCESS_TOKEN).toBe("global-access-new");
  });

  it("keeps the rotated refresh token when optional access-token cache write fails", async () => {
    const repoId = 123;
    const logger = createLogger();
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-old",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.failRepoWritesForKeys.add("ANTHROPIC_OAUTH_ACCESS_TOKEN");
    mockState.refreshImpl.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 1800,
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      logger
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: true,
      accessToken: "access-new",
      expiresIn: 1800,
    });
    expect(mockState.repoWriteAttempts).toHaveLength(2);
    expect(mockState.repoWrites).toHaveLength(1);
    expect(mockState.repoSecrets.get(repoId)?.ANTHROPIC_OAUTH_REFRESH_TOKEN).toBe("refresh-new");
    expect(mockState.repoSecrets.get(repoId)?.ANTHROPIC_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to cache Anthropic access token after refresh",
      {
        source: "repo",
        repo_id: repoId,
        error: "repo write failed",
      }
    );
  });

  it("uses cached token after concurrent rotation when refresh gets 401", async () => {
    vi.useFakeTimers();

    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-stale",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });

    mockState.refreshImpl.mockImplementationOnce(async () => {
      mockState.repoSecrets.set(repoId, {
        ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-rotated",
        ANTHROPIC_OAUTH_ACCESS_TOKEN: "access-concurrent",
        ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      });
      throw new AnthropicTokenRefreshError("unauthorized", 401, "unauthorized");
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const promise = service.refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      accessToken: "access-concurrent",
      expiresIn: expect.any(Number),
    });
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(1);
  });

  it("uses cached token after concurrent rotation when refresh gets invalid_grant", async () => {
    vi.useFakeTimers();

    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-stale",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });

    mockState.refreshImpl.mockImplementationOnce(async () => {
      mockState.repoSecrets.set(repoId, {
        ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-rotated",
        ANTHROPIC_OAUTH_ACCESS_TOKEN: "access-concurrent",
        ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      });
      throw new AnthropicTokenRefreshError("invalid grant", 400, '{"error":"invalid_grant"}');
    });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const promise = service.refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      accessToken: "access-concurrent",
      expiresIn: expect.any(Number),
    });
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(1);
  });

  it("retries with a concurrently rotated refresh token when no access token is cached", async () => {
    vi.useFakeTimers();

    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-stale",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });

    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.repoSecrets.set(repoId, {
          ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-rotated",
          ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
        });
        throw new AnthropicTokenRefreshError("invalid grant", 400, '{"error":"invalid_grant"}');
      })
      .mockResolvedValueOnce({
        access_token: "access-after-retry",
        refresh_token: "refresh-after-retry",
        expires_in: 1800,
      });

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const promise = service.refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      accessToken: "access-after-retry",
      expiresIn: 1800,
    });
    expect(mockState.refreshImpl).toHaveBeenNthCalledWith(1, "refresh-stale");
    expect(mockState.refreshImpl).toHaveBeenNthCalledWith(2, "refresh-rotated");
    expect(mockState.repoSecrets.get(repoId)?.ANTHROPIC_OAUTH_REFRESH_TOKEN).toBe(
      "refresh-after-retry"
    );
  });

  it("logs revoked refresh tokens distinctly when no concurrent rotation is found", async () => {
    vi.useFakeTimers();

    const repoId = 123;
    const logger = createLogger();
    mockState.repoSecrets.set(repoId, {
      ANTHROPIC_OAUTH_REFRESH_TOKEN: "refresh-revoked",
      ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.refreshImpl.mockRejectedValueOnce(
      new AnthropicTokenRefreshError("unauthorized", 401, "unauthorized")
    );

    const service = new AnthropicTokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      logger
    );

    const promise = service.refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Anthropic token refresh failed",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Anthropic refresh token rejected and no newer token was found",
      {
        status: 401,
        source: "repo",
        repo_id: repoId,
        action: "re-run Anthropic OAuth login",
      }
    );
  });
});
