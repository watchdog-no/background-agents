-- Index the quiet-window lookup that batches a burst of pull-request feedback
-- into one session prompt: undecided receipts for a single pull request.
CREATE INDEX IF NOT EXISTS idx_pr_autofix_feedback_pending_pull_request
  ON pr_autofix_feedback (repository_external_id, pr_number, first_received_at DESC)
  WHERE decision = 'received';
