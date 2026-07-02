import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUser, getAppActorToken, getOAuthTokenOrThrow } from "./linear-client";
import type { LinearApiClient } from "./linear-client";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";
import type { Env } from "../types";

const client: LinearApiClient = { accessToken: "test-token" };
const FRESH_TOKEN_EXPIRES_IN_MS = 10 * 60 * 1000;
const EXPIRED_TOKEN_AGE_MS = 60 * 1000;

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

describe("fetchUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns user with name and email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-1", name: "Alice", email: "alice@example.com" },
      },
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toEqual({
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("returns null email when user has no email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-2", name: "Bob", email: null },
      },
    });

    const result = await fetchUser(client, "user-2");
    expect(result).toEqual({
      id: "user-2",
      name: "Bob",
      email: null,
    });
  });

  it("returns null when user is not found", async () => {
    mockFetchResponse({ data: { user: null } });

    const result = await fetchUser(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null on GraphQL errors payload", async () => {
    mockFetchResponse({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });
});

describe("getAppActorToken", () => {
  function makeEnv(entries: Record<string, string>): Env {
    return {
      LINEAR_KV: {
        list: vi.fn(async ({ prefix }: { prefix: string }) => ({
          keys: Object.keys(entries)
            .filter((k) => k.startsWith(prefix))
            .map((name) => ({ name })),
        })),
        get: vi.fn(async (key: string) => entries[key] ?? null),
      },
    } as unknown as Env;
  }

  // A token comfortably inside its validity window, so getOAuthToken returns it
  // directly without attempting an OAuth refresh.
  function freshToken(accessToken: string): string {
    return JSON.stringify({
      access_token: accessToken,
      refresh_token: "refresh",
      expires_at: Date.now() + 60 * 60 * 1000,
    });
  }

  it("returns null when no workspace has authorized the app", async () => {
    const env = makeEnv({});
    expect(await getAppActorToken(env)).toBeNull();
  });

  it("resolves the single workspace token", async () => {
    const env = makeEnv({ "oauth:token:org-1": freshToken("tok-abc") });
    expect(await getAppActorToken(env)).toBe("tok-abc");
  });

  it("returns null when the single workspace token cannot be resolved", async () => {
    const env = makeEnv({ "oauth:token:org-1": "not-json" });
    expect(await getAppActorToken(env)).toBeNull();
  });

  it("fails closed when multiple workspace tokens exist", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // Ambiguous multi-tenant state: guessing a workspace could authenticate the
    // sandbox to the wrong tenant, so the token resolves to null instead.
    const env = makeEnv({
      "oauth:token:org-1": freshToken("tok-1"),
      "oauth:token:org-2": freshToken("tok-2"),
    });
    try {
      expect(await getAppActorToken(env)).toBeNull();
      const logLines = consoleError.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "error",
            msg: "app_token.multiple_workspaces",
            count: 2,
            org_ids: "org-1,org-2",
          }),
        ])
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("getOAuthTokenOrThrow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function envWithToken(raw?: string) {
    const { kv, store } = createFakeKV(raw === undefined ? {} : { "oauth:token:org-1": raw });
    return { env: makeLinearBotEnv(kv), store };
  }

  function expectAuthFailure(promise: Promise<unknown>, failure: Record<string, unknown>) {
    return expect(promise).rejects.toMatchObject({
      name: "LinearAuthError",
      ...failure,
    });
  }

  it("throws an auth error when the workspace token is missing", async () => {
    const { env } = envWithToken();

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "missing_token",
    });
  });

  it("throws an auth error when the workspace token is malformed", async () => {
    const { env } = envWithToken("{not-json");

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "malformed_token",
    });
  });

  it("throws an auth error when the workspace token shape is invalid", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "malformed_token",
    });
  });

  it("throws an auth error when the token read fails", async () => {
    const { env } = envWithToken();
    const kvGet = env.LINEAR_KV.get as unknown as ReturnType<typeof vi.fn>;
    kvGet.mockRejectedValueOnce(new Error("kv down"));

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "token_read_error",
    });
  });

  it("returns a fresh token without refreshing", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOAuthTokenOrThrow(env, "org-1")).resolves.toBe("fresh-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws an auth error when an expired token has no refresh token", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "missing_refresh_token",
    });
  });

  it("classifies invalid_grant refresh failures", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Refresh token has expired.",
            })
          ),
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "refresh_invalid_grant",
      status: 400,
      oauthError: "invalid_grant",
      oauthErrorDescription: "Refresh token has expired.",
    });
  });

  it("classifies other refresh HTTP failures", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("temporarily unavailable"),
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "refresh_failed",
      status: 503,
    });
  });

  it("classifies refresh exceptions", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "refresh_error",
    });
  });

  it("stores and returns refreshed tokens", async () => {
    const { env, store } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "old-refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
      })
    );

    await expect(getOAuthTokenOrThrow(env, "org-1")).resolves.toBe("new-access-token");
    expect(JSON.parse(store.get("oauth:token:org-1") ?? "{}")).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
    });
  });
});
