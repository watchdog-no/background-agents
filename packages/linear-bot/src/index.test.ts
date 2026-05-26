import { describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "@open-inspect/shared";
import app from "./index";
import type { Env } from "./types";

function createMockKV(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ name })),
      };
    }),
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    INTERNAL_CALLBACK_SECRET: "internal-secret",
    LINEAR_KV: createMockKV() as unknown as KVNamespace,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    ...overrides,
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as ExecutionContext;
}

async function authHeaders(secret = "internal-secret"): Promise<Record<string, string>> {
  const token = await generateInternalToken(secret);
  return { Authorization: `Bearer ${token}` };
}

function freshToken(accessToken: string): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: "refresh",
    expires_at: Date.now() + 60 * 60 * 1000,
  });
}

describe("GET /internal/app-token", () => {
  it("returns 500 when internal auth is not configured", async () => {
    const response = await app.fetch(
      new Request("http://localhost/internal/app-token"),
      makeEnv({ INTERNAL_CALLBACK_SECRET: undefined }),
      makeCtx()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Auth not configured" });
  });

  it("returns 401 for invalid internal auth", async () => {
    const response = await app.fetch(
      new Request("http://localhost/internal/app-token", {
        headers: { Authorization: "Bearer invalid" },
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 404 when no workspace has authorized the app", async () => {
    const response = await app.fetch(
      new Request("http://localhost/internal/app-token", {
        headers: await authHeaders(),
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "no_authorized_workspace" });
  });

  it("returns the app actor token for an authorized workspace", async () => {
    const env = makeEnv({
      LINEAR_KV: createMockKV({
        "oauth:token:org-1": freshToken("app-token"),
      }) as unknown as KVNamespace,
    });

    const response = await app.fetch(
      new Request("http://localhost/internal/app-token", {
        headers: await authHeaders(),
      }),
      env,
      makeCtx()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accessToken: "app-token" });
  });
});
