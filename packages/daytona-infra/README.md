# Open-Inspect Daytona Snapshot Tooling

Standalone scripts for seeding and managing Daytona base snapshots used by Open-Inspect sandboxes.

The control plane communicates with the Daytona REST API directly — these scripts are for one-time
snapshot setup, not runtime operations.

## Scripts

- **`src/bootstrap.py`** — Seeds the named Daytona base snapshot from the repo-local sandbox runtime
- **`src/toolchain.py`** — Toolchain management utilities for snapshot images

## Environment

- `DAYTONA_API_KEY` (required) — **Sandboxes: Read, Write, Delete** for runtime lifecycle and
  **Snapshots: Read, Write, Delete** for builds
- `DAYTONA_API_URL`
- `DAYTONA_TARGET`
- `DAYTONA_BASE_SNAPSHOT` (required)

## Usage

```bash
cd packages/daytona-infra
pip install 'daytona==0.161.0'
python -m src.bootstrap
```

Re-run `bootstrap` whenever `packages/sandbox-runtime` or the sandbox toolchain changes.

> **Note**: Snapshot builds are automated via Terraform when `sandbox_provider = "daytona"`. The
> `daytona-infra` Terraform module hashes runtime code, manifests, skills, and build scripts, then
> creates a snapshot named `<DAYTONA_BASE_SNAPSHOT>-<source hash>`. It updates the worker only after
> the snapshot build succeeds. Retries reuse an active snapshot; old snapshots remain available for
> rollback. Remove unused snapshots separately after confirming they are no longer referenced.
> `--force` is only for manually repairing a failed snapshot.
