-- Anthropic models run only on the Claude Agent harness. Move stored
-- automations so the harness they show matches the one their sessions use.
UPDATE automations
SET harness = 'claude',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE harness <> 'claude'
  AND (model LIKE 'anthropic/%' OR model LIKE 'claude-%');
