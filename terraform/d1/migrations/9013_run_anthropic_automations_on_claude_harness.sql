-- Anthropic models run only on the Claude Agent harness. Move stored
-- automations so the harness they show matches the one their sessions use.
-- updated_at is left alone: this realigns derived state, not a user edit.
UPDATE automations
SET harness = 'claude'
WHERE harness <> 'claude'
  AND (model LIKE 'anthropic/%' OR model LIKE 'claude-%');
