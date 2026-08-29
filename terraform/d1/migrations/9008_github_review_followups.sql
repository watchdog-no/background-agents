-- Debounced automatic follow-up for submitted reviews on session-created PRs.

CREATE TABLE IF NOT EXISTS github_review_followups (
  artifact_id       TEXT PRIMARY KEY
                    REFERENCES session_pull_requests(artifact_id) ON DELETE CASCADE,
  generation        INTEGER NOT NULL CHECK (generation > 0),
  first_event_at    INTEGER NOT NULL,
  latest_event_at   INTEGER NOT NULL,
  due_at            INTEGER NOT NULL,
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_review_followups_due
  ON github_review_followups (due_at);

CREATE TABLE IF NOT EXISTS github_review_followup_reviews (
  artifact_id   TEXT NOT NULL
                REFERENCES session_pull_requests(artifact_id) ON DELETE CASCADE,
  review_id     INTEGER NOT NULL CHECK (review_id > 0),
  received_at   INTEGER NOT NULL,
  dispatched_at INTEGER,
  PRIMARY KEY (artifact_id, review_id)
);

CREATE INDEX IF NOT EXISTS idx_github_review_followup_reviews_pending
  ON github_review_followup_reviews (artifact_id, received_at)
  WHERE dispatched_at IS NULL;
