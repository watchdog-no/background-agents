import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { PullRequestLifecycleState } from "@open-inspect/shared/types/artifacts";
import type { SqlDatabase } from "./sql-database";

export interface DueGitHubReviewFollowup {
  artifactId: string;
  sessionId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  lifecycleState: PullRequestLifecycleState;
  sessionStatus: SessionStatus;
  sessionUserId: string | null;
  generation: number;
  firstEventAt: number;
  latestEventAt: number;
  attemptCount: number;
}

interface DueRow {
  artifact_id: string;
  session_id: string;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  lifecycle_state: PullRequestLifecycleState;
  session_status: SessionStatus;
  session_user_id: string | null;
  generation: number;
  first_event_at: number;
  latest_event_at: number;
  attempt_count: number;
}

export interface PendingGitHubReviewFollowupTarget {
  artifactId: string;
  generation: number;
  repoOwner: string;
  repoName: string;
}

export class GitHubReviewFollowupStore {
  constructor(private readonly db: SqlDatabase) {}

  async markPending(params: {
    artifactId: string;
    reviewId: number;
    now: number;
    quietPeriodMs: number;
    maxWaitMs: number;
  }): Promise<void> {
    // generation is an optimistic-concurrency token for one live debounce row:
    // stale sweep completions cannot delete a row advanced by a newer review.
    const { artifactId, reviewId, now, quietPeriodMs, maxWaitMs } = params;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO github_review_followup_reviews
             (artifact_id, review_id, received_at, dispatched_at)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT (artifact_id, review_id) DO NOTHING`
        )
        .bind(artifactId, reviewId, now),
      this.db
        .prepare(
          `INSERT INTO github_review_followups
             (artifact_id, generation, first_event_at, latest_event_at, due_at,
              attempt_count, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (artifact_id) DO UPDATE SET
             generation = github_review_followups.generation + 1,
             latest_event_at = excluded.latest_event_at,
             due_at = MIN(
               github_review_followups.first_event_at + ?,
               excluded.latest_event_at + ?
             ),
             attempt_count = github_review_followups.attempt_count,
             updated_at = excluded.updated_at`
        )
        .bind(artifactId, now, now, now + quietPeriodMs, now, now, maxWaitMs, quietPeriodMs),
    ]);
  }

  async listDue(now: number, limit: number): Promise<DueGitHubReviewFollowup[]> {
    const { results } = await this.db
      .prepare(
        `SELECT f.artifact_id, p.session_id, p.repo_owner, p.repo_name, p.pr_number,
                p.lifecycle_state, s.status AS session_status, s.user_id AS session_user_id,
                f.generation, f.first_event_at, f.latest_event_at, f.attempt_count
         FROM github_review_followups f
         JOIN session_pull_requests p ON p.artifact_id = f.artifact_id
         JOIN sessions s ON s.id = p.session_id
         WHERE f.due_at <= ?
         ORDER BY f.due_at, f.artifact_id
         LIMIT ?`
      )
      .bind(now, limit)
      .all<DueRow>();

    return results.map((row) => ({
      artifactId: row.artifact_id,
      sessionId: row.session_id,
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      prNumber: row.pr_number,
      lifecycleState: row.lifecycle_state,
      sessionStatus: row.session_status,
      sessionUserId: row.session_user_id,
      generation: row.generation,
      firstEventAt: row.first_event_at,
      latestEventAt: row.latest_event_at,
      attemptCount: row.attempt_count,
    }));
  }

  async listPendingReviewIds(artifactId: string): Promise<number[]> {
    const { results } = await this.db
      .prepare(
        `SELECT review_id
         FROM github_review_followup_reviews
         WHERE artifact_id = ? AND dispatched_at IS NULL AND abandoned_at IS NULL
         ORDER BY received_at, review_id`
      )
      .bind(artifactId)
      .all<{ review_id: number }>();
    return results.map((row) => row.review_id);
  }

  async listPendingTargets(): Promise<PendingGitHubReviewFollowupTarget[]> {
    const { results } = await this.db
      .prepare(
        `SELECT f.artifact_id, f.generation, p.repo_owner, p.repo_name
         FROM github_review_followups f
         JOIN session_pull_requests p ON p.artifact_id = f.artifact_id
         ORDER BY f.artifact_id`
      )
      .all<{
        artifact_id: string;
        generation: number;
        repo_owner: string;
        repo_name: string;
      }>();

    return results.map((row) => ({
      artifactId: row.artifact_id,
      generation: row.generation,
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
    }));
  }

  async complete(params: {
    artifactId: string;
    generation: number;
    reviewIds: number[];
    now: number;
  }): Promise<void> {
    const statements = params.reviewIds.map((reviewId) =>
      this.db
        .prepare(
          `UPDATE github_review_followup_reviews
           SET dispatched_at = ?
           WHERE artifact_id = ? AND review_id = ? AND dispatched_at IS NULL`
        )
        .bind(params.now, params.artifactId, reviewId)
    );
    statements.push(
      this.db
        .prepare(
          `DELETE FROM github_review_followups
           WHERE artifact_id = ? AND generation = ?`
        )
        .bind(params.artifactId, params.generation)
    );
    await this.db.batch(statements);
  }

  async retry(params: {
    artifactId: string;
    generation: number;
    attemptCount: number;
    dueAt: number;
    now: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_followups
         SET attempt_count = ?, due_at = ?, updated_at = ?
         WHERE artifact_id = ? AND generation = ?`
      )
      .bind(params.attemptCount, params.dueAt, params.now, params.artifactId, params.generation)
      .run();
  }

  async delete(artifactId: string, generation: number): Promise<void> {
    // D1 batch statements execute in order. The child delete is guarded by the
    // same generation before the parent debounce row is removed.
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM github_review_followup_reviews
           WHERE artifact_id = ?
             AND dispatched_at IS NULL
             AND EXISTS (
               SELECT 1 FROM github_review_followups
               WHERE artifact_id = ? AND generation = ?
             )`
        )
        .bind(artifactId, artifactId, generation),
      this.db
        .prepare(
          `DELETE FROM github_review_followups
           WHERE artifact_id = ? AND generation = ?`
        )
        .bind(artifactId, generation),
    ]);
  }

  async abandon(params: {
    artifactId: string;
    generation: number;
    reason: string;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_followup_reviews
           SET abandoned_at = ?, abandon_reason = ?
           WHERE artifact_id = ?
             AND dispatched_at IS NULL
             AND abandoned_at IS NULL
             AND EXISTS (
               SELECT 1 FROM github_review_followups
               WHERE artifact_id = ? AND generation = ?
             )`
        )
        .bind(params.now, params.reason, params.artifactId, params.artifactId, params.generation),
      this.db
        .prepare(
          `DELETE FROM github_review_followups
           WHERE artifact_id = ? AND generation = ?`
        )
        .bind(params.artifactId, params.generation),
    ]);
  }
}
