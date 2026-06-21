import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RepoConfig } from "../types";

const {
  mockFetch,
  mockGetAvailableRepos,
  mockBuildRepoDescriptions,
  mockGetReposByChannel,
  mockGetRoutingRules,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
  mockGetReposByChannel: vi.fn(),
  mockGetRoutingRules: vi.fn(),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  buildRepoDescriptions: mockBuildRepoDescriptions,
  getReposByChannel: mockGetReposByChannel,
  getRoutingRules: mockGetRoutingRules,
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

const TEST_ENV = {
  CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
  INTERNAL_CALLBACK_SECRET: "test-secret",
  CONTROL_PLANE: { fetch: mockFetch },
} as unknown as Env;

/** Build a JSON Response for the mocked control-plane fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetReposByChannel.mockResolvedValue([]);
    mockGetRoutingRules.mockResolvedValue([]);
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

    expect(result.repo?.fullName).toBe("acme/prod");
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

  it("flags an infra failure (with reason) when the endpoint errors", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ reason: "oauth_unauthorized", message: "rejected" }, 502)
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("frontend UI issue in web app");

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.failureReason).toBe("oauth_unauthorized");
    expect(result.reasoning).toContain("classifier failed to run");
    expect(result.alternatives).toBeUndefined();
  });

  it("flags a failure when the endpoint returns an invalid payload", async () => {
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

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.failureReason).toBe("provider_error");
  });

  it("skips the endpoint when a channel is mapped to a single repo", async () => {
    mockGetReposByChannel.mockResolvedValue([TEST_REPOS[1]]);

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("anything", { channelId: "C123" });

    expect(result.repo?.fullName).toBe("acme/web");
    expect(result.needsClarification).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("routing rules", () => {
    it("routes deterministically when a keyword matches, without calling the LLM", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("please fix the frontend nav bug", undefined, "t");

      expect(result.repo?.fullName).toBe("acme/web");
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

      expect(result.repo).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.alternatives?.map((r) => r.fullName).sort()).toEqual(["acme/prod", "acme/web"]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes once when multiple keywords map to the same repo", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "ui", target: "acme/web" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend ui cleanup");

      expect(result.repo?.fullName).toBe("acme/web");
      expect(result.needsClarification).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips a rule whose target is not accessible and falls through to the LLM", async () => {
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

      expect(result.repo?.fullName).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("falls through to the LLM when no rule keyword is present", async () => {
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

      expect(result.repo?.fullName).toBe("acme/prod");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("takes precedence over a channel association", async () => {
      // Channel maps to acme/prod, but an explicit keyword maps to acme/web.
      mockGetReposByChannel.mockResolvedValue([TEST_REPOS[0]]); // acme/prod
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend tweak", { channelId: "C123" });

      expect(result.repo?.fullName).toBe("acme/web");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
