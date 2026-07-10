-- Complete upstream migration 0040 after fork-local repo_images migrations.
-- Existing deployments may already have dropped the table via 0040, while
-- fresh installs retain it through 9001 so that migration can replay safely.

DROP TABLE IF EXISTS repo_images;
