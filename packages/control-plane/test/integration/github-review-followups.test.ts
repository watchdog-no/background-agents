import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { GitHubReviewFollowupStore } from "../../src/db/github-review-followups";
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
