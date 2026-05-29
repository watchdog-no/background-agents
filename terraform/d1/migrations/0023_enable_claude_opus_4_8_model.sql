-- Auto-enable Claude Opus 4.8 for deployments that already saved model preferences.
UPDATE model_preferences
SET
  enabled_models = json_insert(enabled_models, '$[#]', 'anthropic/claude-opus-4-8'),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'global'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(model_preferences.enabled_models)
    WHERE value = 'anthropic/claude-opus-4-8'
  );
