-- Retire the fork's GitHub review follow-up in favour of upstream Autofix.
--
-- The follow-up sweep and upstream's Autofix both resumed a session from
-- pull-request review feedback, by different paths and with no shared dedupe,
-- so a repository with both enabled would have been woken twice for one review.
-- Autofix is now the single path; this drops the follow-up's storage and
-- removes its setting from persisted integration settings.
--
-- Stripping the setting is required, not cosmetic: `githubBotSettingsSchema` is
-- a strict object, so a stored `autoAddressReviewFeedback` key would fail to
-- parse once the field is gone from the schema. Migrations run before the
-- control-plane worker deploys (workers-control-plane.tf depends_on
-- null_resource.d1_migrations), so the key is gone before the new schema loads.

DROP TABLE IF EXISTS github_review_followup_reviews;
DROP TABLE IF EXISTS github_review_followups;

UPDATE integration_settings
SET settings = json_remove(settings, '$.defaults.autoAddressReviewFeedback')
WHERE integration_id = 'github'
  AND json_type(settings, '$.defaults.autoAddressReviewFeedback') IS NOT NULL;

UPDATE integration_repo_settings
SET settings = json_remove(settings, '$.autoAddressReviewFeedback')
WHERE integration_id = 'github'
  AND json_type(settings, '$.autoAddressReviewFeedback') IS NOT NULL;

UPDATE integration_environment_settings
SET settings = json_remove(settings, '$.autoAddressReviewFeedback')
WHERE integration_id = 'github'
  AND json_type(settings, '$.autoAddressReviewFeedback') IS NOT NULL;
