-- Auto-enable GPT-5.6 variants for deployments that already saved model preferences.
UPDATE model_preferences
SET
  enabled_models = json_insert(enabled_models, '$[#]', 'openai/gpt-5.6-sol'),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'global'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(model_preferences.enabled_models)
    WHERE value = 'openai/gpt-5.6-sol'
  );

UPDATE model_preferences
SET
  enabled_models = json_insert(enabled_models, '$[#]', 'openai/gpt-5.6-terra'),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'global'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(model_preferences.enabled_models)
    WHERE value = 'openai/gpt-5.6-terra'
  );

UPDATE model_preferences
SET
  enabled_models = json_insert(enabled_models, '$[#]', 'openai/gpt-5.6-luna'),
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'global'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(model_preferences.enabled_models)
    WHERE value = 'openai/gpt-5.6-luna'
  );
