import { describe, expect, it, vi } from "vitest";
import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import type { Logger } from "../logger";
import type { DueGitHubReviewFollowup } from "../db/github-review-followups";
import {
  GitHubReviewFollowupSweep,
  REVIEW_FOLLOWUP_MAX_WAIT_MS,
  REVIEW_FOLLOWUP_QUIET_PERIOD_MS,
  admitGitHubReviewFollowup,
  buildGitHubReviewFollowupRequestId,
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
    review: { id: 77, state: "commented", isBotActor: false },
    meta: { reviewId: 77, reviewState: "commented" },
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
    [
      "approved",
      { review: { id: 77, state: "approved", isBotActor: false } },
      "review_state_ignored",
    ],
    ["self-authored", { review: { id: 77, state: "commented", isBotActor: true } }, "bot_authored"],
    ["missing bot attribution", { review: { id: 77, state: "commented" } }, "bot_authored"],
    [
      "invalid review id",
      { review: { id: 0, state: "commented", isBotActor: false } },
      "review_state_ignored",
    ],
    ["draft", { pullRequest: { number: 12, state: "open", draft: true } }, "pr_not_open"],
    ["closed", { pullRequest: { number: 12, state: "closed" } }, "pr_not_open"],
    [
      "cross-repository",
      { pullRequest: { number: 12, state: "open", isCrossRepository: true } },
      "pr_not_open",
    ],
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

  it("skips a repository outside the configured scope", async () => {
    const deps = admissionDeps({
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: ["other/repo"],
          settings: { autoAddressReviewFeedback: true },
        }),
      },
    });

    await expect(admitGitHubReviewFollowup(deps, reviewEvent())).resolves.toBe("repo_not_enabled");
    expect(deps.pullRequests.getByIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["unowned pull request", null, "pr_not_owned"],
    ["missing session", { status: null }, "session_not_promptable"],
  ])("skips %s", async (_name, state, outcome) => {
    const deps = admissionDeps(
      state === null
        ? { pullRequests: { getByIdentity: vi.fn().mockResolvedValue(null) } }
        : { sessions: { get: vi.fn().mockResolvedValue(state.status) } }
    );

    await expect(admitGitHubReviewFollowup(deps, reviewEvent())).resolves.toBe(outcome);
    expect(deps.followups.markPending).not.toHaveBeenCalled();
  });

  it("skips a pull request whose ownership record is no longer open", async () => {
    const deps = admissionDeps({
      pullRequests: {
        getByIdentity: vi.fn().mockResolvedValue({
          artifactId: "artifact-1",
          sessionId: "session-1",
          lifecycleState: "closed",
        }),
      },
    });

    await expect(admitGitHubReviewFollowup(deps, reviewEvent())).resolves.toBe("pr_not_owned");
    expect(deps.followups.markPending).not.toHaveBeenCalled();
  });

  it("skips an archived original session", async () => {
    const deps = admissionDeps({
      sessions: { get: vi.fn().mockResolvedValue({ status: "archived" }) },
    });

    await expect(admitGitHubReviewFollowup(deps, reviewEvent())).resolves.toBe(
      "session_not_promptable"
    );
    expect(deps.followups.markPending).not.toHaveBeenCalled();
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
  it("uses review identity rather than resettable generation for request idempotency", () => {
    expect(buildGitHubReviewFollowupRequestId("artifact-1", [77, 88])).toBe(
      "github-review:artifact-1:88"
    );
    expect(buildGitHubReviewFollowupRequestId("artifact-1", [99])).toBe(
      "github-review:artifact-1:99"
    );
  });

  it("enqueues one review batch into the original session", async () => {
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77, 88]),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      abandon: vi.fn().mockResolvedValue(undefined),
    };
    const enqueue = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const reviews = {
      load: vi.fn().mockResolvedValue([
        {
          id: 77,
          author: "review-agent",
          body: "Please handle <edge cases>.",
          state: "COMMENTED",
          url: "https://github.com/acme/web/pull/12#pullrequestreview-77",
          submittedAt: "2026-08-29T08:00:00Z",
          inlineComments: [
            {
              id: 901,
              author: "review-agent",
              body: "This should be guarded.",
              path: "src/index.ts",
              line: 42,
              side: "RIGHT",
              url: "https://github.com/acme/web/pull/12#discussion_r901",
            },
          ],
        },
      ]),
    };
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
      },
      reviews,
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
        clientRequestId: "github-review:artifact-1:88",
        coalescingKey: "github-review:artifact-1",
        pendingAppendContent: expect.stringContaining('<review id="77"'),
        content: expect.stringMatching(
          /Github review was posted to the PR you published: acme\/web#12\.[\s\S]*Review IDs: 77, 88/
        ),
      })
    );
    const prompt = enqueue.mock.calls[0]?.[1]?.content as string;
    expect(prompt).toContain("<![CDATA[Please handle <edge cases>.]]>");
    expect(prompt).toContain('<inline-comment id="901" path="src/index.ts" line="42" side="RIGHT"');
    expect(prompt.match(/^ {2}<review /gm)).toHaveLength(2);
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
      abandon: vi.fn(),
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
      reviews: { load: vi.fn() },
      enqueue,
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.delete).toHaveBeenCalledWith("artifact-1", 3);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([425, 429])(
    "defers queue contention without consuming retry attempts (%s)",
    async (status) => {
      const store = {
        listDue: vi.fn().mockResolvedValue([dueRow]),
        listPendingReviewIds: vi.fn().mockResolvedValue([77]),
        complete: vi.fn(),
        retry: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(),
        abandon: vi.fn(),
      };
      const sweep = new GitHubReviewFollowupSweep({
        store,
        settings: {
          resolve: vi.fn().mockResolvedValue({
            enabledRepos: null,
            settings: { autoAddressReviewFeedback: true },
          }),
        },
        reviews: { load: vi.fn().mockResolvedValue([]) },
        enqueue: vi.fn().mockResolvedValue(new Response(null, { status })),
        log: logger(),
        now: () => 10_000,
      });

      await sweep.run();

      expect(store.retry).toHaveBeenCalledWith({
        artifactId: "artifact-1",
        generation: 3,
        attemptCount: 0,
        dueAt: 70_000,
        now: 10_000,
      });
      expect(store.complete).not.toHaveBeenCalled();
      expect(store.delete).not.toHaveBeenCalled();
      expect(store.abandon).not.toHaveBeenCalled();
    }
  );

  it("retries a total review-content failure without consuming the batch", async () => {
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77]),
      complete: vi.fn(),
      retry: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      abandon: vi.fn(),
    };
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
      },
      reviews: { load: vi.fn().mockRejectedValue(new Error("GitHub unavailable")) },
      enqueue: vi.fn(),
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.retry).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      generation: 3,
      attemptCount: 1,
      dueAt: 70_000,
      now: 10_000,
    });
    expect(store.complete).not.toHaveBeenCalled();
  });

  it.each([400, 404, 409])("audits a permanent enqueue failure (%s)", async (status) => {
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77]),
      complete: vi.fn(),
      retry: vi.fn(),
      delete: vi.fn(),
      abandon: vi.fn().mockResolvedValue(undefined),
    };
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
      },
      reviews: { load: vi.fn().mockResolvedValue([]) },
      enqueue: vi.fn().mockResolvedValue(new Response(null, { status })),
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.abandon).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      generation: 3,
      reason: `enqueue_http_${status}`,
      now: 10_000,
    });
  });

  it.each([
    ["enqueue exception", new Error("DO unavailable")],
    ["server response", new Response(null, { status: 503 })],
  ])("backs off after an %s", async (_name, outcome) => {
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77]),
      complete: vi.fn(),
      retry: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      abandon: vi.fn(),
    };
    const enqueue =
      outcome instanceof Error
        ? vi.fn().mockRejectedValue(outcome)
        : vi.fn().mockResolvedValue(outcome);
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
      },
      reviews: { load: vi.fn().mockResolvedValue([]) },
      enqueue,
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.retry).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      generation: 3,
      attemptCount: 1,
      dueAt: 70_000,
      now: 10_000,
    });
  });

  it("audits a batch after exhausting retry attempts", async () => {
    const exhaustedRow = { ...dueRow, attemptCount: 7 };
    const store = {
      listDue: vi.fn().mockResolvedValue([exhaustedRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77]),
      complete: vi.fn(),
      retry: vi.fn(),
      delete: vi.fn(),
      abandon: vi.fn().mockResolvedValue(undefined),
    };
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings: {
        resolve: vi.fn().mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
      },
      reviews: { load: vi.fn().mockResolvedValue([]) },
      enqueue: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.abandon).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      generation: 3,
      reason: "retry_exhausted",
      now: 10_000,
    });
    expect(store.retry).not.toHaveBeenCalled();
  });

  it("isolates one failed due row and continues dispatching the next", async () => {
    const secondRow = { ...dueRow, artifactId: "artifact-2", sessionId: "session-2" };
    const store = {
      listDue: vi.fn().mockResolvedValue([dueRow, secondRow]),
      listPendingReviewIds: vi.fn().mockResolvedValue([77]),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      abandon: vi.fn(),
    };
    const settings = {
      resolve: vi
        .fn()
        .mockRejectedValueOnce(new Error("D1 unavailable"))
        .mockResolvedValue({
          enabledRepos: null,
          settings: { autoAddressReviewFeedback: true },
        }),
    };
    const enqueue = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const sweep = new GitHubReviewFollowupSweep({
      store,
      settings,
      reviews: { load: vi.fn().mockResolvedValue([]) },
      enqueue,
      log: logger(),
      now: () => 10_000,
    });

    await sweep.run();

    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "artifact-1", attemptCount: 1 })
    );
    expect(enqueue).toHaveBeenCalledWith("session-2", expect.any(Object));
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "artifact-2" })
    );
  });
});
