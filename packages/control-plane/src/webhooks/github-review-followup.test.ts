import { describe, expect, it, vi } from "vitest";
import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import type { Logger } from "../logger";
import type { DueGitHubReviewFollowup } from "../db/github-review-followups";
import {
  GitHubReviewFollowupSweep,
  REVIEW_FOLLOWUP_MAX_WAIT_MS,
  REVIEW_FOLLOWUP_QUIET_PERIOD_MS,
  admitGitHubReviewFollowup,
} from "./github-review-followup";

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function reviewEvent(overrides: Partial<GitHubAutomationEvent> = {}): GitHubAutomationEvent {
  return {
    source: "github",
    eventType: "pull_request_review.submitted",
    triggerKey: "pr_review:77",
    concurrencyKey: "pr:12",
    contextBlock: "review",
    repoOwner: "acme",
    repoName: "web",
    branch: "open-inspect/session-1",
    actor: "reviewer",
    pullRequest: {
      number: 12,
      state: "open",
      draft: false,
      isCrossRepository: false,
      repositoryExternalId: "321",
    },
    meta: { reviewId: 77, reviewState: "commented", isBotActor: false },
    ...overrides,
  };
}

function admissionDeps(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      resolve: vi.fn().mockResolvedValue({
        enabledRepos: null,
        settings: { autoAddressReviewFeedback: true },
      }),
    },
    followups: { markPending: vi.fn().mockResolvedValue(undefined) },
    pullRequests: {
      getByIdentity: vi.fn().mockResolvedValue({
        artifactId: "artifact-1",
        sessionId: "session-1",
        lifecycleState: "open",
      }),
    },
    sessions: { get: vi.fn().mockResolvedValue({ status: "completed" }) },
    log: logger(),
    now: () => 1_000,
    ...overrides,
  };
}

describe("admitGitHubReviewFollowup", () => {
  it("queues actionable feedback for the original promptable session", async () => {
    const deps = admissionDeps();

    await expect(admitGitHubReviewFollowup(deps, reviewEvent())).resolves.toBe("queued");
    expect(deps.pullRequests.getByIdentity).toHaveBeenCalledWith({
      repositoryExternalId: "321",
      repoOwner: "acme",
      repoName: "web",
      prNumber: 12,
    });
    expect(deps.followups.markPending).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: REVIEW_FOLLOWUP_QUIET_PERIOD_MS,
      maxWaitMs: REVIEW_FOLLOWUP_MAX_WAIT_MS,
    });
  });

  it.each([
    ["approved", { meta: { reviewId: 77, reviewState: "approved" } }, "review_state_ignored"],
    [
      "self-authored",
      { meta: { reviewId: 77, reviewState: "commented", isBotActor: true } },
      "bot_authored",
    ],
    ["draft", { pullRequest: { number: 12, state: "open", draft: true } }, "pr_not_open"],
  ])("ignores %s reviews", async (_name, eventOverrides, outcome) => {
    const deps = admissionDeps();

    await expect(
      admitGitHubReviewFollowup(deps, reviewEvent(eventOverrides as Partial<GitHubAutomationEvent>))
    ).resolves.toBe(outcome);
    expect(deps.followups.markPending).not.toHaveBeenCalled();
  });

  it("fails closed when the setting is off", async () => {
    const deps = admissionDeps({
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: false },
        }),
      },
    });

    await expect(admitGitHubReviewFollowup(deps, reviewEvent())).resolves.toBe("setting_disabled");
    expect(deps.pullRequests.getByIdentity).not.toHaveBeenCalled();
  });
});

const dueRow: DueGitHubReviewFollowup = {
  artifactId: "artifact-1",
  sessionId: "session-1",
  repoOwner: "acme",
  repoName: "web",
  prNumber: 12,
  lifecycleState: "open",
  sessionStatus: "completed",
  sessionUserId: "user-1",
  generation: 3,
  firstEventAt: 1_000,
  latestEventAt: 2_000,
  attemptCount: 0,
};

describe("GitHubReviewFollowupSweep", () => {
  it("enqueues one review batch into the original session", async () => {
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77, 88]),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const enqueue = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
      },
      enqueue,
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(enqueue).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        authorId: "user-1",
        canonicalUserId: "user-1",
        source: "github-review",
        clientRequestId: "github-review:artifact-1:3",
        content: expect.stringMatching(
          /Github review was posted to the PR you published: acme\/web#12\.[\s\S]*Review IDs: 77, 88/
        ),
      })
    );
    expect(store.complete).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      generation: 3,
      reviewIds: [77, 88],
      now: 10_000,
    });
  });

  it("cancels a pending batch when the setting is turned off", async () => {
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow]),
      listPendingReviewIds: vi.fn(),
      complete: vi.fn(),
      retry: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const enqueue = vi.fn();
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: false },
        }),
      },
      enqueue,
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.delete).toHaveBeenCalledWith("artifact-1", 3);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
