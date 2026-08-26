import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";

const { mockFetch, mockGetAvailableRepos, mockBuildRepoDescriptions } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  buildRepoDescriptions: mockBuildRepoDescriptions,
}));

import { CLASSIFIER_REQUEST_TIMEOUT_MS, classifyRepo } from "./index";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function classify(env: Env = TEST_ENV) {
  return classifyRepo(
    env,
    "Fix prod worker",
    "the prod worker is down",
    [],
    null,
    null,
    null,
    null,
    "trace-1"
  );
}

describe("classifyRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockBuildRepoDescriptions.mockResolvedValue("- acme/prod\n- acme/web");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a confident endpoint result onto a repo and sends prompt + model", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        repoId: "acme/prod",
        confidence: "high",
        reasoning: "Mentions prod worker.",
        alternatives: [],
      })
    );

    const result = await classify();

    expect(result.repo?.fullName).toBe("acme/prod");
    expect(result.needsClarification).toBe(false);
    expect(result.failureReason).toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://internal/classify");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe("openai/gpt-5.6-luna");
    expect(typeof sent.prompt).toBe("string");
    expect(new Headers((init as RequestInit).headers).get("X-OpenInspect-Service")).toBe(
      "linear-bot"
    );
  });

  it("sets failureReason when the endpoint reports an infra error", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ reason: "oauth_unauthorized", message: "rejected" }, 502)
    );

    const result = await classify();

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.failureReason).toBe("oauth_unauthorized");
    expect(result.reasoning).toContain("classifier failed to run");
  });

  it("rejects malformed endpoint results", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        repoId: "acme/prod",
        confidence: "certain",
        reasoning: "Invalid confidence.",
      })
    );

    const result = await classify();

    expect(result.repo).toBeNull();
    expect(result.needsClarification).toBe(true);
    expect(result.failureReason).toBe("provider_error");
  });

  it("short-circuits to the only repo without calling the endpoint", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);

    const result = await classify();

    expect(result.repo?.fullName).toBe("acme/prod");
    expect(result.needsClarification).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to clarification when the classifier request times out", async () => {
    const timeoutSignal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    mockFetch.mockImplementation(async (_input, init) => {
      expect(init?.signal).toBe(timeoutSignal);
      throw timeoutSignal.reason;
    });

    const result = await classify();

    expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFIER_REQUEST_TIMEOUT_MS);
    expect(result).toEqual({
      repo: null,
      confidence: "low",
      reasoning:
        "The repository classifier failed to run, so I couldn't auto-detect the repository. Please reply with the repository name (e.g., `owner/repo`).",
      alternatives: TEST_REPOS,
      needsClarification: true,
      failureReason: "provider_error",
    });
  });
});
