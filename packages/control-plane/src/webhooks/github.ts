/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot. User-facing
 * events go to the automation scheduler; submitted reviews stay internal and
 * may resume the session that published the PR. PR lifecycle tracking
 * piggybacks on the same ingress (design §5.2).
 */

import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import { SessionIndexStore } from "../db/session-index";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { GitHubReviewFollowupStore } from "../db/github-review-followups";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { createLogger, parseLogLevel } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import type { RequestContext, Route } from "../routes/shared";
import {
  defineRoute,
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  parsePattern,
} from "../routes/shared";
import { requireEventPoster } from "../auth/identity-enforcement";
import {
  forwardAutomationEventToScheduler,
  logAutomationEventRejection,
  validateAutomationEventEnvelope,
} from "./automation-event";
import {
  processPullRequestLifecycleEvent,
  type PullRequestLifecycleOutcome,
  type PullRequestLifecycleDeps,
  type SessionArtifactSummary,
} from "./pull-request-lifecycle";
import { admitGitHubReviewFollowup } from "./github-review-followup";

/**
 * Best-effort PR lifecycle tracking for one normalized event. Submitted
 * reviews await it for ownership repair; other events run it in waitUntil.
 * Every failure is logged and swallowed.
 */
async function trackPullRequestLifecycle(
  env: Env,
  event: GitHubAutomationEvent,
  ctx: RequestContext
): Promise<PullRequestLifecycleOutcome | null> {
  const log = createLogger(
    "webhook:pr-lifecycle",
    { trace_id: ctx.trace_id, request_id: ctx.request_id },
    parseLogLevel(env.LOG_LEVEL)
  );
  try {
    if (!env.SESSION) return null;

    if (!event.pullRequest) return null;

    const sessionRuntime = createSessionRuntimeClient(env, ctx);
    const deps: PullRequestLifecycleDeps = {
      store: new SessionPullRequestStore(ctx.db),
      sessions: new SessionIndexStore(ctx.db),
      listSessionArtifacts: async (sessionId): Promise<SessionArtifactSummary[]> => {
        const response = await sessionRuntime.fetch(sessionId, SessionInternalPaths.artifacts, {
          method: "GET",
        });
        if (!response.ok) return [];
        const body = await response.json<{ artifacts?: SessionArtifactSummary[] }>();
        return body.artifacts ?? [];
      },
      pushSnapshotToSession: async (sessionId, artifactId, snapshot) => {
        const response = await sessionRuntime.fetch(
          sessionId,
          SessionInternalPaths.pullRequestArtifactSnapshot,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(snapshot),
          },
          `?artifactId=${encodeURIComponent(artifactId)}`
        );
        // fetch resolves on 4xx/5xx — a rejected push must fail loudly
        // instead of reading as a mirrored update. The D1 authority has
        // already advanced; read-through repairs the mirror.
        if (!response.ok) {
          throw new Error(`Snapshot push to session DO failed (status ${response.status})`);
        }
      },
      now: () => Date.now(),
    };

    const outcome = await processPullRequestLifecycleEvent(deps, event);
    const details = {
      outcome,
      event_type: event.eventType,
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      pr_number: event.pullRequest?.number,
    };
    if (outcome === "record_write_failed") {
      log.error("pull_request_lifecycle.record_write_failed", details);
    } else {
      log.info("pull_request_lifecycle.processed", details);
    }
    return outcome;
  } catch (err) {
    log.error("pull_request_lifecycle.failed", {
      error: err instanceof Error ? err : String(err),
    });
    return null;
  }
}

async function handleGitHubAutomationEvent(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const authFailure = requireEventPoster(ctx, "github");
  if (authFailure) return authFailure;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logAutomationEventRejection(undefined, "github", ["body"], ctx);
    return error("Invalid JSON", 400);
  }

  const validated = validateAutomationEventEnvelope(body, "github");
  if (validated.response) {
    logAutomationEventRejection(body, "github", validated.issuePaths, ctx);
    return validated.response;
  }

  const isSubmittedReview = validated.event.eventType === "pull_request_review.submitted";
  if (isSubmittedReview) {
    // Review follow-up admission depends on the PR ownership record. Repair the
    // best-effort creation write first when this webhook can supply it.
    await trackPullRequestLifecycle(env, validated.event, ctx);
  }

  const settings = new IntegrationSettingsStore(ctx.db);
  const followupLog = createLogger(
    "webhook:github-review-followup",
    { trace_id: ctx.trace_id, request_id: ctx.request_id },
    parseLogLevel(env.LOG_LEVEL)
  );
  let followupOutcome: Awaited<ReturnType<typeof admitGitHubReviewFollowup>> = "not_review";
  let followupAdmissionFailed = false;
  try {
    followupOutcome = await admitGitHubReviewFollowup(
      {
        settings: {
          resolve: (repo) => settings.getResolvedConfig("github", repo),
        },
        followups: new GitHubReviewFollowupStore(ctx.db),
        pullRequests: new SessionPullRequestStore(ctx.db),
        sessions: new SessionIndexStore(ctx.db),
        log: followupLog,
        now: () => Date.now(),
      },
      validated.event
    );
  } catch (admissionError) {
    followupAdmissionFailed = true;
    followupLog.error("github_review_followup.admission_failed", {
      repo_owner: validated.event.repoOwner,
      repo_name: validated.event.repoName,
      pr_number: validated.event.pullRequest?.number,
      error: admissionError instanceof Error ? admissionError : new Error(String(admissionError)),
    });
  }

  if (!isSubmittedReview) {
    ctx.executionCtx.submit(() => trackPullRequestLifecycle(env, validated.event, ctx), {
      name: "github_webhook.lifecycle",
    });
  }

  if (followupOutcome !== "not_review" && followupOutcome !== "queued") {
    followupLog.info("github_review_followup.skipped", {
      outcome: followupOutcome,
      repo_owner: validated.event.repoOwner,
      repo_name: validated.event.repoName,
      pr_number: validated.event.pullRequest?.number,
    });
  }

  if (isSubmittedReview) {
    if (followupAdmissionFailed) {
      return error("GitHub review follow-up admission unavailable", 503);
    }
    return json({ ok: true, triggered: 0, skipped: 0 });
  }

  return forwardAutomationEventToScheduler(env, validated.event, ctx);
}

export const githubAutomationEventRoute: Route = defineRoute(GITHUB_USER_OR_SERVICE_ROUTE, {
  method: "POST",
  pattern: parsePattern("/internal/github-event"),
  handler: handleGitHubAutomationEvent,
});
