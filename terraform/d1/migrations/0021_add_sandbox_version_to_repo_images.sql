-- Track the sandbox/base-image toolchain version used to build repo images.
-- Empty string means the image predates explicit version tracking.
ALTER TABLE repo_images ADD COLUMN sandbox_version TEXT NOT NULL DEFAULT '';
