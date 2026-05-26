import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUser, getAppActorToken } from "./linear-client";
import type { LinearApiClient } from "./linear-client";
import type { Env } from "../types";

const client: LinearApiClient = { accessToken: "test-token" };

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
