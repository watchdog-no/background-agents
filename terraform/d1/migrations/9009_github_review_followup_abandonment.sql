-- Preserve permanently abandoned review feedback for operator audit.

ALTER TABLE github_review_followup_reviews ADD COLUMN abandoned_at INTEGER;
ALTER TABLE github_review_followup_reviews ADD COLUMN abandon_reason TEXT;

DROP INDEX IF EXISTS idx_github_review_followup_reviews_pending;
CREATE INDEX idx_github_review_followup_reviews_pending
  ON github_review_followup_reviews (artifact_id, received_at)
  WHERE dispatched_at IS NULL AND abandoned_at IS NULL;
