import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Environment, RepoConfig } from "../types";

const {
  mockFetch,
  mockGetAvailableRepos,
  mockBuildRepoDescriptions,
  mockGetRoutingRules,
  mockGetAvailableEnvironments,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
  mockGetRoutingRules: vi.fn(),
  mockGetAvailableEnvironments: vi.fn(),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  buildRepoDescriptions: mockBuildRepoDescriptions,
  getRoutingRules: mockGetRoutingRules,
}));

vi.mock("./environments", () => ({
  getAvailableEnvironments: mockGetAvailableEnvironments,
  // Imported by targets.ts (via ../targets); unused in these tests.
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
    aliases: ["production"],
    keywords: ["worker", "slack"],
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
    aliases: ["frontend"],
    keywords: ["react", "ui"],
  },
];

const TEST_ENVIRONMENT: Environment = {
  id: "env_abc123",
  name: "full-stack",
  description: null,
  prebuildEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  repositories: [
    { repoOwner: "acme", repoName: "prod", repoId: 1, baseBranch: "main" },
    { repoOwner: "acme", repoName: "web", repoId: 2, baseBranch: "main" },
  ],
};

const TEST_ENV = {
  CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
  INTERNAL_CALLBACK_SECRET: "test-secret",
  CONTROL_PLANE: { fetch: mockFetch },
} as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function classifiedRepoFullName(result: {
  target: { kind: string; repo?: { fullName: string } } | null;
}): string | undefined {
  return result.target?.kind === "repository" ? result.target.repo?.fullName : undefined;
}

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetRoutingRules.mockResolvedValue([]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
    mockBuildRepoDescriptions.mockResolvedValue("- acme/prod\n- acme/web");
  });

  it("uses the /classify endpoint output for a confident match", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        repoId: "acme/prod",
        confidence: "high",
        reasoning: "The message explicitly mentions prod.",
        alternatives: [],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts", undefined, "trace-1");

    expect(classifiedRepoFullName(result)).toBe("acme/prod");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(result.failureReason).toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://internal/classify");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.model).toBe("anthropic/claude-haiku-4-5");
    expect(typeof sentBody.prompt).toBe("string");
  });

  it("flags an infra failure with the endpoint reason when the endpoint errors", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ reason: "oauth_unauthorized", message: "rejected" }, 502)
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("frontend UI issue in web app");

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.failureReason).toBe("oauth_unauthorized");
    expect(result.reasoning).toContain("classifier failed to run");
    expect(result.alternatives).toBeUndefined();
  });

  it("flags a provider failure when the endpoint returns an invalid payload", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        repoId: "acme/prod",
        confidence: "certain",
        reasoning: "Totally sure",
        alternatives: [],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please update prod deployment config");

    expect(result.target).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.failureReason).toBe("provider_error");
  });

  it("skips the endpoint when only one repository is available", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[1]]);

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("anything");

    expect(classifiedRepoFullName(result)).toBe("acme/web");
    expect(result.needsClarification).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("routing rules", () => {
    it("routes deterministically when a keyword matches, without calling the endpoint", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("please fix the frontend nav bug", undefined, "t");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(result.confidence).toBe("high");
      expect(result.needsClarification).toBe(false);
      expect(result.reasoning).toContain("routing rule");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("asks for clarification when rules point at multiple distinct repos", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "prod", target: "acme/prod" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fix the frontend on prod");

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(
        result.alternatives?.map((t) => (t.kind === "repository" ? t.repo.fullName : "")).sort()
      ).toEqual(["acme/prod", "acme/web"]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes once when multiple keywords map to the same repo", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "ui", target: "acme/web" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend ui cleanup");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(result.needsClarification).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips a rule whose target is not accessible and falls through to the endpoint", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/ghost" }]);
      mockFetch.mockResolvedValue(
        jsonResponse({
          repoId: "acme/web",
          confidence: "high",
          reasoning: "Mentions frontend.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend issue");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("falls through to the endpoint when no rule keyword is present", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);
      mockFetch.mockResolvedValue(
        jsonResponse({
          repoId: "acme/prod",
          confidence: "high",
          reasoning: "Mentions prod.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("update the deployment config");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("takes precedence over a channel association", async () => {
      mockGetAvailableRepos.mockResolvedValue([
        { ...TEST_REPOS[0], channelAssociations: ["C123"] },
        TEST_REPOS[1],
      ]);
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend tweak", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes to an environment when an environment-targeted keyword matches", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack login flow", undefined, "t");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(result.confidence).toBe("high");
      expect(result.needsClarification).toBe(false);
      expect(result.reasoning).toContain("full-stack");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("escapes the environment name in the mrkdwn reasoning", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "deploy", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([
        { ...TEST_ENVIRONMENT, name: "<!channel> & co" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("deploy the app");

      expect(result.reasoning).toContain("&lt;!channel&gt; &amp; co");
      expect(result.reasoning).not.toContain("<!channel>");
    });

    it("does not fetch environments when no matched rule targets one", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("frontend tweak");

      expect(mockGetAvailableEnvironments).not.toHaveBeenCalled();
    });

    it("routes an environment rule even when only one repository is available", async () => {
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack login flow");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes an environment rule even when no repositories are available", async () => {
      mockGetAvailableRepos.mockResolvedValue([]);
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack login flow");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(result.needsClarification).toBe(false);
      expect(result.reasoning).not.toContain("No repositories");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("asks for clarification when rules resolve to a repo and an environment", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend or fullstack?");

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.alternatives).toEqual([
        { kind: "repository", repo: TEST_REPOS[1] },
        { kind: "environment", environment: TEST_ENVIRONMENT },
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips a rule whose environment no longer exists and falls through to the endpoint", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_deleted", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockFetch.mockResolvedValue(
        jsonResponse({
          repoId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack web app issue");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe("channel associations", () => {
    it("routes to the repository associated with the channel, without the endpoint", async () => {
      mockGetAvailableRepos.mockResolvedValue([
        { ...TEST_REPOS[0], channelAssociations: ["C123"] },
        TEST_REPOS[1],
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toContain("associated with repository acme/prod");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes to the environment associated with the channel", async () => {
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toEqual({ kind: "environment", environment });
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toContain("associated with environment full-stack");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("escapes the channel-associated environment name in the mrkdwn reasoning", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([
        { ...TEST_ENVIRONMENT, name: "<!channel> & co", channelAssociations: ["C123"] },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.reasoning).toContain("&lt;!channel&gt; &amp; co");
      expect(result.reasoning).not.toContain("<!channel>");
    });

    it("routes an environment association even when only one repository is available", async () => {
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toEqual({ kind: "environment", environment });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes an environment association even when no repositories are available", async () => {
      mockGetAvailableRepos.mockResolvedValue([]);
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toEqual({ kind: "environment", environment });
      expect(result.needsClarification).toBe(false);
      expect(result.reasoning).not.toContain("No repositories");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("asks for clarification when the channel maps to a repo and an environment", async () => {
      const associatedRepo = { ...TEST_REPOS[0], channelAssociations: ["C123"] };
      mockGetAvailableRepos.mockResolvedValue([associatedRepo, TEST_REPOS[1]]);
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.alternatives).toEqual([
        { kind: "environment", environment },
        { kind: "repository", repo: associatedRepo },
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls through to the endpoint when several repositories share the channel", async () => {
      mockGetAvailableRepos.mockResolvedValue(
        TEST_REPOS.map((repo) => ({ ...repo, channelAssociations: ["C123"] }))
      );
      mockFetch.mockResolvedValue(
        jsonResponse({
          repoId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("web app issue", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("does not consult environments for messages outside a channel context", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          repoId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("web app issue");

      expect(mockGetAvailableEnvironments).not.toHaveBeenCalled();
    });
  });
});
