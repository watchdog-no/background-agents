-- Enable Astra for saved catalogs and migrate future agent launches from Sol.
-- Completed and running sessions retain their historical model identity.
UPDATE model_preferences
SET enabled_models = json_insert(enabled_models, '$[#]', 'openai/gpt-6-astra'),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM json_each(model_preferences.enabled_models)
                  WHERE value = 'openai/gpt-6-astra');

UPDATE automations
SET model = 'openai/gpt-6-astra',
    reasoning_effort = CASE WHEN reasoning_effort = 'none' THEN 'medium' ELSE reasoning_effort END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE model IN ('openai/gpt-5.6-sol', 'gpt-5.6-sol');

UPDATE integration_settings
SET settings = CASE
      WHEN json_extract(settings, '$.defaults.reasoningEffort') = 'none'
      THEN json_set(settings, '$.defaults.model', 'openai/gpt-6-astra', '$.defaults.reasoningEffort', 'medium')
      ELSE json_set(settings, '$.defaults.model', 'openai/gpt-6-astra')
    END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE json_extract(settings, '$.defaults.model') IN ('openai/gpt-5.6-sol', 'gpt-5.6-sol');

UPDATE integration_repo_settings
SET settings = CASE
      WHEN json_extract(settings, '$.reasoningEffort') = 'none'
      THEN json_set(settings, '$.model', 'openai/gpt-6-astra', '$.reasoningEffort', 'medium')
      ELSE json_set(settings, '$.model', 'openai/gpt-6-astra')
    END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE json_extract(settings, '$.model') IN ('openai/gpt-5.6-sol', 'gpt-5.6-sol');

UPDATE integration_environment_settings
SET settings = CASE
      WHEN json_extract(settings, '$.reasoningEffort') = 'none'
      THEN json_set(settings, '$.model', 'openai/gpt-6-astra', '$.reasoningEffort', 'medium')
      ELSE json_set(settings, '$.model', 'openai/gpt-6-astra')
    END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE json_extract(settings, '$.model') IN ('openai/gpt-5.6-sol', 'gpt-5.6-sol');
