import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { AgentSessionWebhookIssue, Env } from "./types";
import type { LinearApiClient } from "./utils/linear-client";

const mocks = vi.hoisted(() => ({
  classifyRepo: vi.fn(),
  emitAgentActivity: vi.fn(),
  getAvailableRepos: vi.fn(),
  getProjectRepoMapping: vi.fn(),
  getRepoSuggestions: vi.fn(),
  getTeamRepoMapping: vi.fn(),
}));

vi.mock("./classifier", () => ({ classifyRepo: mocks.classifyRepo }));
vi.mock("./classifier/repos", () => ({ getAvailableRepos: mocks.getAvailableRepos }));
vi.mock("./kv-store", () => ({
  getProjectRepoMapping: mocks.getProjectRepoMapping,
  getTeamRepoMapping: mocks.getTeamRepoMapping,
}));
vi.mock("./utils/linear-client", () => ({
  emitAgentActivity: mocks.emitAgentActivity,
  getRepoSuggestions: mocks.getRepoSuggestions,
}));

import { resolveSessionTarget } from "./target-resolution";

const REPOS: RepoConfig[] = [
  {
    id: "watchdog-no/watchdog-monorepo",
    owner: "watchdog-no",
    name: "watchdog-monorepo",
    fullName: "watchdog-no/watchdog-monorepo",
    displayName: "watchdog-monorepo",
    description: "Main repository",
    defaultBranch: "main",
    private: true,
  },
  {
    id: "watchdog-no/background-agents",
    owner: "watchdog-no",
    name: "background-agents",
    fullName: "watchdog-no/background-agents",
    displayName: "background-agents",
    description: "Agent system",
    defaultBranch: "main",
    private: true,
  },
];

const ISSUE = {
  id: "issue-1",
  identifier: "WD-1",
  title: "Fix routing",
  url: "https://linear.app/watchdog/issue/WD-1/fix-routing",
  priority: 0,
  priorityLabel: "No priority",
  team: { id: "team-1", key: "WD", name: "Watchdog" },
} satisfies AgentSessionWebhookIssue;

function resolve(envOverrides: Partial<Env> = {}) {
  return resolveSessionTarget({
    env: envOverrides as Env,
    client: {} as LinearApiClient,
    agentSessionId: "agent-session-1",
    issue: ISSUE,
    labelNames: [],
    projectInfo: null,
    comment: null,
    traceId: "trace-1",
  });
}

describe("resolveSessionTarget default repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectRepoMapping.mockResolvedValue({});
    mocks.getTeamRepoMapping.mockResolvedValue({});
    mocks.getAvailableRepos.mockResolvedValue(REPOS);
    mocks.getRepoSuggestions.mockResolvedValue([]);
  });

  it("uses the configured default before the LLM fallback", async () => {
    const result = await resolve({
      CLASSIFICATION_DEFAULT_REPOSITORY: "watchdog-no/watchdog-monorepo",
    });

    expect(result?.target).toEqual({
      kind: "repository",
      owner: "watchdog-no",
      name: "watchdog-monorepo",
      fullName: "watchdog-no/watchdog-monorepo",
    });
    expect(result?.reasoning).toContain("configured default repository");
    expect(mocks.classifyRepo).not.toHaveBeenCalled();
  });

  it("keeps a confident Linear suggestion ahead of the default", async () => {
    mocks.getRepoSuggestions.mockResolvedValue([
      { repositoryFullName: "watchdog-no/background-agents", confidence: 0.9 },
    ]);

    const result = await resolve({
      CLASSIFICATION_DEFAULT_REPOSITORY: "watchdog-no/watchdog-monorepo",
    });

    expect(result?.target).toMatchObject({
      kind: "repository",
      fullName: "watchdog-no/background-agents",
    });
    expect(mocks.classifyRepo).not.toHaveBeenCalled();
  });
});
