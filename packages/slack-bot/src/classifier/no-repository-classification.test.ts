import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";

const { mockFetch, mockGetAvailableRepos, mockGetRoutingRules, mockGetAvailableEnvironments } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockGetAvailableRepos: vi.fn(),
    mockGetRoutingRules: vi.fn(),
    mockGetAvailableEnvironments: vi.fn(),
  }));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  getRoutingRules: mockGetRoutingRules,
  buildRepoDescriptions: vi.fn(() => "- acme/prod\n- acme/web"),
}));

vi.mock("./environments", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getAvailableEnvironments: mockGetAvailableEnvironments,
  getEnvironmentById: vi.fn(),
}));

import { RepoClassifier } from "./index";

const TEST_REPOS: RepoConfig[] = [
  {
    id: "acme/prod",
    owner: "acme",
    name: "prod",
    fullName: "acme/prod",
    displayName: "prod",
    description: "Production worker",
    defaultBranch: "main",
    private: true,
  },
  {
    id: "acme/web",
    owner: "acme",
    name: "web",
    fullName: "acme/web",
    displayName: "web",
    description: "Web application",
    defaultBranch: "main",
    private: true,
  },
];

const TEST_ENV = {
  SERVICE_AUTH_SECRET: "test-secret",
  CONTROL_PLANE: { fetch: mockFetch },
} as unknown as Env;

/**
 * The bots classify through the control plane's `/classify` endpoint, which
 * owns the provider credentials and answers with the tool's raw result.
 */
function mockClassifyResult(input: {
  targetId: string | null;
  confidence: string;
  reasoning: string;
  alternatives: string[];
}): void {
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ ...input, repoId: input.targetId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("RepoClassifier no-repository policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetRoutingRules.mockResolvedValue([]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
  });

  it("accepts a high-confidence inferred no-repository target", async () => {
    mockClassifyResult({
      targetId: "__no_repository__",
      confidence: "high",
      reasoning: "This research does not require the codebase.",
      alternatives: ["acme/web"],
    });

    const result = await new RepoClassifier(TEST_ENV).classify("Research deployment patterns");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(false);
  });

  it("clarifies a low-confidence no-repository target", async () => {
    mockClassifyResult({
      targetId: "__no_repository__",
      confidence: "low",
      reasoning: "The target is unclear.",
      alternatives: ["acme/web"],
    });

    const result = await new RepoClassifier(TEST_ENV).classify("Research authentication options");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(true);
  });

  it("offers the no-repository target as an alternative alongside a repository match", async () => {
    mockClassifyResult({
      targetId: "acme/web",
      confidence: "medium",
      reasoning: "Probably the web app, but the task may need no repository at all.",
      alternatives: ["__no_repository__"],
    });

    const result = await new RepoClassifier(TEST_ENV).classify("Look into the login flow");

    expect(result.alternatives).toEqual([{ kind: "none" }]);
    expect(result.needsClarification).toBe(true);
  });
});
