import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretsRoutes } from "./secrets";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mockRepoStore = vi.hoisted(() => ({
  setSecrets: vi.fn(),
  listSecrets: vi.fn(),
  deleteSecret: vi.fn(),
}));

const mockGlobalStore = vi.hoisted(() => ({
  setSecrets: vi.fn(),
  listSecrets: vi.fn(),
  deleteSecret: vi.fn(),
}));

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: vi.fn().mockImplementation(() => mockRepoStore),
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: vi.fn().mockImplementation(() => mockGlobalStore),
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn().mockResolvedValue({
      repoId: 123,
      repoOwner: "acme",
      repoName: "app",
      defaultBranch: "main",
    }),
  };
});

function getHandler(method: string, path: string) {
  for (const route of secretsRoutes) {
    if (route.method === method && route.pattern.test(path)) {
      const match = path.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    REPO_SECRETS_ENCRYPTION_KEY: "test-encryption-key",
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callRoute(method: string, path: string): Promise<Response> {
  const { handler, match } = getHandler(method, path);
  return handler(
    new Request(`https://test.local${path}`, { method }),
    createEnv(),
    match,
    createCtx()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("secrets routes", () => {
  it("returns global secret values when listing global secrets", async () => {
    mockGlobalStore.listSecrets.mockResolvedValue([
      { key: "API_KEY", value: "global-secret", createdAt: 1, updatedAt: 2 },
    ]);

    const response = await callRoute("GET", "/secrets");

    expect(response.status).toBe(200);
    const body = await response.json<{
      secrets: Array<{ key: string; value: string; createdAt: number; updatedAt: number }>;
    }>();
    expect(body.secrets).toEqual([
      { key: "API_KEY", value: "global-secret", createdAt: 1, updatedAt: 2 },
    ]);
  });

  it("returns repo and inherited global secret values when listing repo secrets", async () => {
    mockRepoStore.listSecrets.mockResolvedValue([
      { key: "REPO_KEY", value: "repo-secret", createdAt: 3, updatedAt: 4 },
    ]);
    mockGlobalStore.listSecrets.mockResolvedValue([
      { key: "GLOBAL_KEY", value: "global-secret", createdAt: 1, updatedAt: 2 },
    ]);

    const response = await callRoute("GET", "/repos/acme/app/secrets");

    expect(response.status).toBe(200);
    const body = await response.json<{
      repo: string;
      secrets: Array<{ key: string; value: string }>;
      globalSecrets: Array<{ key: string; value: string }>;
    }>();
    expect(body.repo).toBe("acme/app");
    expect(body.secrets).toEqual([
      expect.objectContaining({ key: "REPO_KEY", value: "repo-secret" }),
    ]);
    expect(body.globalSecrets).toEqual([
      expect.objectContaining({ key: "GLOBAL_KEY", value: "global-secret" }),
    ]);
  });
});
