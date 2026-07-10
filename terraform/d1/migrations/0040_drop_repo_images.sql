-- repo_images is dropped by fork-local migration 9005 after 9001 has run.
--
-- Rows are NOT migrated. They are cache entries, and the unified table keys
-- selection on repositories_fingerprint — which is a SHA-256 over the ordered
-- (owner, name, base_branch) set, not computable in SQL. The rebuild cron
-- sees no ready image for each enabled repo and rebuilds it within about one
-- tick; repo sessions boot from the base image until then (slower boots, no
-- failures).
--
-- repo_metadata.image_build_enabled stays where it is: enablement is entity
-- metadata, read by the scope resolver (image-builds/scope.ts).
--
-- Upstream drops the table in this migration. This fork already shipped 9001,
-- which adds sandbox_version to repo_images and sorts after upstream's numeric
-- band. Keeping the table through 9001 makes fresh installs replayable; 9005
-- performs the final idempotent drop.

SELECT 1;
