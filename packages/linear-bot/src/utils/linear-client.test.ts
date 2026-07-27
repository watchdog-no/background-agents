import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentActivity,
  fetchIssueDetails,
  fetchUser,
  getAppActorToken,
  getRepoSuggestions,
} from "./linear-client";
import type { LinearApiClient } from "./linear-client";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

const client: LinearApiClient = {
  accessToken: "test-token",
  organizationId: "org-1",
  renewAccessToken: vi.fn(async () => "renewed-token"),
};

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

function cachedClientCredentialsToken(
  accessToken: string,
  organizationId: string,
  appUserId = "app-user-1"
): string {
  const issuedAt = Date.now();
  return JSON.stringify({
    version: 1,
    access_token: accessToken,
    token_type: "Bearer",
    scope: "read,write,app:assignable,app:mentionable",
    issued_at: issuedAt,
    expires_at: issuedAt + 60 * 60 * 1000,
    organization_id: organizationId,
    organization_name: "Acme",
    app_user_id: appUserId,
  });
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

  it("returns null when the user payload is malformed", async () => {
    mockFetchResponse({ data: { user: { id: "user-1", email: "alice@example.com" } } });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });
});

describe("fetchIssueDetails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns issue details with nullable fields", async () => {
    mockFetchResponse({
      data: {
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          title: "Fix bug",
          description: null,
          url: "https://linear.app/acme/issue/ENG-1",
          priority: 2,
          priorityLabel: "High",
          labels: { nodes: [{ id: "label-1", name: "bug" }] },
          project: null,
          assignee: null,
          team: { id: "team-1", key: "ENG", name: "Engineering" },
          comments: { nodes: [{ body: "please fix", user: null }] },
        },
      },
    });

    await expect(fetchIssueDetails(client, "issue-1")).resolves.toEqual({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Fix bug",
      description: null,
      url: "https://linear.app/acme/issue/ENG-1",
      priority: 2,
      priorityLabel: "High",
      labels: [{ id: "label-1", name: "bug" }],
      project: null,
      assignee: null,
      team: { id: "team-1", key: "ENG", name: "Engineering" },
      comments: [{ body: "please fix", user: null }],
    });
  });

  it("returns null when the issue payload is malformed", async () => {
    mockFetchResponse({ data: { issue: { id: "issue-1", title: "missing fields" } } });

    await expect(fetchIssueDetails(client, "issue-1")).resolves.toBeNull();
  });
});

describe("getRepoSuggestions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed repo suggestions", async () => {
    mockFetchResponse({
      data: {
        issueRepositorySuggestions: {
          suggestions: [{ repositoryFullName: "acme/api", confidence: 0.92 }],
        },
      },
    });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([
      { repositoryFullName: "acme/api", confidence: 0.92 },
    ]);
  });

  it("returns an empty list when suggestions are null", async () => {
    mockFetchResponse({ data: { issueRepositorySuggestions: null } });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([]);
  });

  it("returns an empty list when suggestions are malformed", async () => {
    mockFetchResponse({
      data: { issueRepositorySuggestions: { suggestions: [{ repositoryFullName: "acme/api" }] } },
    });

    await expect(getRepoSuggestions(client, "issue-1", "agent-1", [])).resolves.toEqual([]);
  });
});

describe("getAppActorToken", () => {
  it("returns null when no workspace has authorized the app", async () => {
    const { kv } = createFakeKV();
    await expect(getAppActorToken(makeLinearBotEnv(kv))).resolves.toBeNull();
  });

  it("resolves the single workspace client-credentials token", async () => {
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedClientCredentialsToken("tok-abc", "org-1"),
    });
    await expect(getAppActorToken(makeLinearBotEnv(kv))).resolves.toBe("tok-abc");
  });

  it("fails closed when multiple workspace tokens exist", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { kv } = createFakeKV({
      "oauth:client-credentials:org-1": cachedClientCredentialsToken("tok-1", "org-1"),
      "oauth:client-credentials:org-2": cachedClientCredentialsToken("tok-2", "org-2"),
    });

    await expect(getAppActorToken(makeLinearBotEnv(kv))).resolves.toBeNull();
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
  });
});

describe("emitAgentActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a failed terminal activity delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(
      emitAgentActivity(client, "agent-session-1", {
        type: "response",
        body: "Finished",
      })
    ).resolves.toBe(false);
  });
});
