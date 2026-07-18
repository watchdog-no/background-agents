/**
 * Linear API client utilities — OAuth + raw GraphQL.
 */

import type { Env, LinearIssueDetails } from "../types";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "./crypto";
import { createLogger } from "../logger";
import {
  getClientCredentialsTokenOrThrow,
  LINEAR_CLIENT_CREDENTIALS_SCOPE,
  LinearAuthError,
} from "./linear-credentials";

export {
  completeLinearOAuthInstallation,
  getClientCredentialsTokenOrThrow,
  LinearAuthError,
  type LinearAuthFailure,
  type LinearAuthFailureReason,
} from "./linear-credentials";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const CLIENT_CREDENTIALS_TOKEN_KEY_PREFIX = "oauth:client-credentials:";

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

export function buildOAuthAuthorizeUrl(env: Env): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", LINEAR_CLIENT_CREDENTIALS_SCOPE);
  authUrl.searchParams.set("actor", "app");
  return authUrl.toString();
}

// ─── Linear API Client ──────────────────────────────────────────────────────

export interface LinearApiClient {
  accessToken: string;
  organizationId: string;
  renewAccessToken: () => Promise<string>;
}

export async function getLinearClient(
  env: Env,
  orgId: string,
  expectedAppUserId: string
): Promise<LinearApiClient | null> {
  try {
    return await getLinearClientOrThrow(env, orgId, expectedAppUserId);
  } catch (err) {
    if (err instanceof LinearAuthError) return null;
    throw err;
  }
}

export async function getLinearClientOrThrow(
  env: Env,
  orgId: string,
  expectedAppUserId: string
): Promise<LinearApiClient> {
  return {
    accessToken: await getClientCredentialsTokenOrThrow(env, orgId, { expectedAppUserId }),
    organizationId: orgId,
    renewAccessToken: () =>
      getClientCredentialsTokenOrThrow(env, orgId, {
        forceRenew: true,
        expectedAppUserId,
      }),
  };
}

/**
 * Mint a fresh app-actor access token for the (single-tenant) workspace.
 *
 * Open-Inspect is single-tenant, so at most one workspace completes the OAuth
 * install and exactly one `oauth:client-credentials:*` entry lives in KV. This
 * resolves that entry and returns a valid token, transparently renewing it.
 * Used by the control plane to inject `LINEAR_API_KEY="Bearer <token>"` into
 * sandboxes so the coding agent acts as the Linear app, not a human user.
 *
 * Returns null when no workspace has authorized the app yet, or when more than
 * one workspace token exists. The latter is fail-closed on purpose: with
 * multiple tokens we cannot know which workspace the sandbox should act as, and
 * arbitrarily picking one risks authenticating the agent to the wrong workspace
 * and writing comments/updates into the wrong tenant. An operator must delete
 * the stale client-credentials cache entries before app-actor access resumes.
 */
export async function getAppActorToken(env: Env): Promise<string | null> {
  const { keys } = await env.LINEAR_KV.list({ prefix: CLIENT_CREDENTIALS_TOKEN_KEY_PREFIX });
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    // Single-tenant invariant violated — fail closed rather than guess a tenant.
    log.error("app_token.multiple_workspaces", {
      count: keys.length,
      org_ids: keys
        .map((key) => key.name.slice(CLIENT_CREDENTIALS_TOKEN_KEY_PREFIX.length))
        .join(","),
    });
    return null;
  }
  const orgId = keys[0].name.slice(CLIENT_CREDENTIALS_TOKEN_KEY_PREFIX.length);
  try {
    return await getClientCredentialsTokenOrThrow(env, orgId);
  } catch (error) {
    if (!(error instanceof LinearAuthError)) throw error;
    log.error("app_token.unavailable", {
      org_id: orgId,
      auth_failure_reason: error.reason,
      status: error.status,
    });
    return null;
  }
}

/**
 * Execute a GraphQL query against the Linear API.
 */
export async function linearGraphQL(
  client: LinearApiClient,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ query, variables });
  const send = (accessToken: string) =>
    fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    });

  let res = await send(client.accessToken);
  if (res.status === 401) {
    log.warn("linear.graphql.unauthorized", { org_id: client.organizationId });
    let renewedToken: string;
    try {
      renewedToken = await client.renewAccessToken();
    } catch (error) {
      if (error instanceof LinearAuthError) throw error;
      throw new LinearAuthError({ reason: "client_credentials_error" });
    }
    client.accessToken = renewedToken;
    res = await send(renewedToken);
    if (res.status === 401) {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
      throw new LinearAuthError({
        reason: "client_credentials_rejected",
        status: res.status,
      });
    }
    if (res.ok) {
      log.info("linear.graphql.retry_succeeded", {
        org_id: client.organizationId,
        status: res.status,
      });
    } else {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
    }
  }

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msg = (json.errors[0] as { message?: string }).message ?? "Unknown GraphQL error";
    throw new Error(`Linear GraphQL error: ${msg}`);
  }

  return json;
}

// ─── Agent Activities ────────────────────────────────────────────────────────

export async function emitAgentActivity(
  client: LinearApiClient,
  agentSessionId: string,
  content: Record<string, unknown>,
  ephemeral?: boolean
): Promise<boolean> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `,
      {
        input: { agentSessionId, content, ephemeral },
      }
    );
    return true;
  } catch (err) {
    log.error("linear.emit_activity_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

// ─── Issue Details ───────────────────────────────────────────────────────────

// Fetch the TAIL of the comment connection (`last`, backward pagination) so the
// genuinely most-recent comments are present — `first` returns the oldest, which
// on a busy issue would drop the newest user instructions before buildPrompt
// ever sees them. With `orderBy: createdAt` the page is still oldest-first within
// itself, so buildPrompt's slice(-MAX_FALLBACK_COMMENTS) keeps the latest few.
const COMMENT_FETCH_LIMIT = 50;

/**
 * Fetch full issue details from Linear API.
 */
export async function fetchIssueDetails(
  client: LinearApiClient,
  issueId: string
): Promise<LinearIssueDetails | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query IssueDetails($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          priorityLabel
          labels { nodes { id name } }
          project { id name }
          assignee { id name }
          team { id key name }
          comments(last: ${COMMENT_FETCH_LIMIT}, orderBy: createdAt) {
            nodes {
              body
              user { name }
            }
          }
        }
      }
    `,
      { id: issueId }
    );

    const issue = (data as { data?: { issue?: Record<string, unknown> } }).data?.issue;
    if (!issue) return null;

    return {
      id: issue.id as string,
      identifier: issue.identifier as string,
      title: issue.title as string,
      description: issue.description as string | null,
      url: issue.url as string,
      priority: issue.priority as number,
      priorityLabel: issue.priorityLabel as string,
      labels: (issue.labels as { nodes: Array<{ id: string; name: string }> })?.nodes || [],
      project: issue.project as { id: string; name: string } | null,
      assignee: issue.assignee as { id: string; name: string } | null,
      team: issue.team as { id: string; key: string; name: string },
      comments:
        (issue.comments as { nodes: Array<{ body: string; user?: { name: string } }> })?.nodes ||
        [],
    };
  } catch (err) {
    log.error("linear.fetch_issue_details", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Agent Session Management ────────────────────────────────────────────────

/**
 * Update an agent session (externalUrls, plan, etc.)
 */
export async function updateAgentSession(
  client: LinearApiClient,
  agentSessionId: string,
  input: Record<string, unknown>
): Promise<void> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }
    `,
      { id: agentSessionId, input }
    );
  } catch (err) {
    log.error("linear.update_session_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Use Linear's built-in repo suggestion API for issue→repo matching.
 */
export async function getRepoSuggestions(
  client: LinearApiClient,
  issueId: string,
  agentSessionId: string,
  candidateRepos: Array<{ hostname: string; repositoryFullName: string }>
): Promise<Array<{ repositoryFullName: string; confidence: number }>> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query RepoSuggestions($issueId: String!, $agentSessionId: String!, $candidateRepositories: [IssueRepositorySuggestionInput!]!) {
        issueRepositorySuggestions(
          issueId: $issueId
          agentSessionId: $agentSessionId
          candidateRepositories: $candidateRepositories
        ) {
          suggestions {
            repositoryFullName
            confidence
          }
        }
      }
    `,
      { issueId, agentSessionId, candidateRepositories: candidateRepos }
    );

    const result = data as {
      data?: {
        issueRepositorySuggestions?: {
          suggestions: Array<{ repositoryFullName: string; confidence: number }>;
        };
      };
    };
    return result.data?.issueRepositorySuggestions?.suggestions || [];
  } catch (err) {
    log.error("linear.repo_suggestions_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

// ─── User Lookup ────────────────────────────────────────────────────────────

/**
 * Fetch a Linear user by ID. Returns name and email for identity linking.
 */
export async function fetchUser(
  client: LinearApiClient,
  userId: string
): Promise<{ id: string; name: string; email: string | null } | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query FetchUser($id: String!) {
        user(id: $id) {
          id
          name
          email
        }
      }
    `,
      { id: userId }
    );

    const user = (data as { data?: { user?: Record<string, unknown> } }).data?.user;
    if (!user) return null;

    return {
      id: user.id as string,
      name: user.name as string,
      email: (user.email as string) ?? null,
    };
  } catch (err) {
    log.error("linear.fetch_user", {
      user_id: userId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Webhook Verification ────────────────────────────────────────────────────

export async function verifyLinearWebhook(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;
  const expectedHex = await computeHmacHex(body, secret);
  return timingSafeEqual(signature, expectedHex);
}

// ─── Comment Posting (fallback) ──────────────────────────────────────────────

export async function postIssueComment(
  apiKey: string,
  issueId: string,
  body: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }
      `,
      variables: { input: { issueId, body } },
    }),
  });

  if (!response.ok) return { success: false };
  const result = (await response.json()) as {
    data?: { commentCreate?: { success: boolean } };
  };
  return { success: result.data?.commentCreate?.success ?? false };
}
