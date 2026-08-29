import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { GitHubReviewFollowupStore } from "../../src/db/github-review-followups";
import { buildGitHubReviewFollowupRequestId } from "../../src/webhooks/github-review-followup";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionPullRequestStore } from "../../src/db/session-pull-request-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("GitHubReviewFollowupStore", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await new SessionIndexStore(env.DB).create({
      id: "session-1",
      title: null,
      repoOwner: "acme",
      repoName: "web",
      model: "test-model",
      reasoningEffort: null,
      baseBranch: "main",
      status: "completed",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await new SessionPullRequestStore(env.DB).upsert({
      artifactId: "artifact-1",
      sessionId: "session-1",
      repositoryExternalId: "321",
      repoOwner: "acme",
      repoName: "web",
      prNumber: 12,
      url: "https://github.com/acme/web/pull/12",
      lifecycleState: "open",
      isDraft: false,
      headBranch: "open-inspect/session-1",
      baseBranch: "main",
      headSha: "abc123",
      providerCreatedAt: 500,
      providerUpdatedAt: 1_000,
      mergedAt: null,
      closedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("debounces reviews with a fixed quiet period and maximum wait", async () => {
    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    expect(await store.listDue(120_999, 10)).toEqual([]);

    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 88,
      now: 60_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    expect(await store.listDue(179_999, 10)).toEqual([]);
    expect(await store.listDue(180_000, 10)).toEqual([
      expect.objectContaining({ artifactId: "artifact-1", generation: 2 }),
    ]);

    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 99,
      now: 590_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    expect(await store.listDue(600_999, 10)).toEqual([]);
    expect(await store.listDue(601_000, 10)).toEqual([
      expect.objectContaining({ artifactId: "artifact-1", generation: 3 }),
    ]);
    expect(await store.listPendingReviewIds("artifact-1")).toEqual([77, 88, 99]);
  });

  it("keeps a newer review generation when an older dispatch completes", async () => {
    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    const [firstBatch] = await store.listDue(121_000, 10);

    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 88,
      now: 122_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    await store.complete({
      artifactId: "artifact-1",
      generation: firstBatch.generation,
      reviewIds: [77],
      now: 123_000,
    });

    expect(await store.listPendingReviewIds("artifact-1")).toEqual([88]);
    expect(await store.listDue(242_000, 10)).toEqual([
      expect.objectContaining({ artifactId: "artifact-1", generation: 2 }),
    ]);
  });

  it("uses distinct request ids when a later debounce cycle resets generation", async () => {
    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    const [firstBatch] = await store.listDue(121_000, 10);
    const firstReviewIds = await store.listPendingReviewIds("artifact-1");
    await store.complete({
      artifactId: "artifact-1",
      generation: firstBatch.generation,
      reviewIds: firstReviewIds,
      now: 122_000,
    });

    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 88,
      now: 200_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    const [secondBatch] = await store.listDue(320_000, 10);
    const secondReviewIds = await store.listPendingReviewIds("artifact-1");

    expect(secondBatch.generation).toBe(firstBatch.generation);
    expect(buildGitHubReviewFollowupRequestId("artifact-1", firstReviewIds)).toBe(
      "github-review:artifact-1:77"
    );
    expect(buildGitHubReviewFollowupRequestId("artifact-1", secondReviewIds)).toBe(
      "github-review:artifact-1:88"
    );
  });

  it("preserves retry progress when another review joins the batch", async () => {
    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    await store.retry({
      artifactId: "artifact-1",
      generation: 1,
      attemptCount: 3,
      dueAt: 500_000,
      now: 130_000,
    });
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 88,
      now: 200_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });

    expect(await store.listDue(320_000, 10)).toEqual([
      expect.objectContaining({ generation: 2, attemptCount: 3 }),
    ]);
  });

  it("retains an audit record when a batch is abandoned", async () => {
    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });

    await store.abandon({
      artifactId: "artifact-1",
      generation: 1,
      reason: "enqueue_http_400",
      now: 10_000,
    });

    expect(await store.listPendingReviewIds("artifact-1")).toEqual([]);
    const audit = await env.DB.prepare(
      `SELECT review_id, abandoned_at, abandon_reason
       FROM github_review_followup_reviews WHERE artifact_id = ?`
    )
      .bind("artifact-1")
      .all<{ review_id: number; abandoned_at: number; abandon_reason: string }>();
    expect(audit.results).toEqual([
      { review_id: 77, abandoned_at: 10_000, abandon_reason: "enqueue_http_400" },
    ]);
  });

  it("cancels pending review ids without deleting a newer generation", async () => {
    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    await store.delete("artifact-1", 1);
    expect(await store.listPendingReviewIds("artifact-1")).toEqual([]);

    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 88,
      now: 2_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 99,
      now: 3_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });
    await store.delete("artifact-1", 1);

    expect(await store.listPendingReviewIds("artifact-1")).toEqual([88, 99]);
    expect(await store.listDue(123_000, 10)).toEqual([
      expect.objectContaining({ artifactId: "artifact-1", generation: 2 }),
    ]);
  });

  it("cancels waiting feedback when settings make the repository ineligible", async () => {
    await serviceFetch("https://test.local/integration-settings/github", {
      method: "PUT",
      body: JSON.stringify({
        settings: { defaults: { autoAddressReviewFeedback: true } },
      }),
    });

    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });

    const response = await serviceFetch("https://test.local/integration-settings/github", {
      method: "PUT",
      body: JSON.stringify({
        settings: { defaults: { autoAddressReviewFeedback: false } },
      }),
    });

    expect(response.status).toBe(200);
    expect(await store.listPendingReviewIds("artifact-1")).toEqual([]);
  });

  it("preserves waiting feedback for a repository that remains explicitly enabled", async () => {
    await serviceFetch("https://test.local/integration-settings/github", {
      method: "PUT",
      body: JSON.stringify({
        settings: { defaults: { autoAddressReviewFeedback: true } },
      }),
    });
    await serviceFetch("https://test.local/integration-settings/github/repos/acme/web", {
      method: "PUT",
      body: JSON.stringify({ settings: { autoAddressReviewFeedback: true } }),
    });

    const store = new GitHubReviewFollowupStore(env.DB);
    await store.markPending({
      artifactId: "artifact-1",
      reviewId: 77,
      now: 1_000,
      quietPeriodMs: 120_000,
      maxWaitMs: 600_000,
    });

    const response = await serviceFetch("https://test.local/integration-settings/github", {
      method: "PUT",
      body: JSON.stringify({
        settings: { defaults: { autoAddressReviewFeedback: false } },
      }),
    });

    expect(response.status).toBe(200);
    expect(await store.listPendingReviewIds("artifact-1")).toEqual([77]);
  });
});
