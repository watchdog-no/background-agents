# Watchdog Daytona deployment (reverted)

The September 8, 2026 Daytona production cutover from PR #80 is reverted. Watchdog Open Inspect
selects **Modal** in `terraform/environments/production/sandbox.auto.tfvars`; Daytona is no longer
used for new sessions. Modal credentials remain in Actions secrets. This does not migrate the
Watchdog application's separate sandbox integration.

The instructions below are historical context for the Daytona integration, not the active production
configuration. Existing Daytona filesystem state does not transfer to Modal; any sessions created on
Daytona need a fresh session after the switch.

The original cutover selected Daytona in `terraform/environments/production/sandbox.auto.tfvars`.
This non-secret configuration is reviewed with the code and takes precedence over the old
`SANDBOX_PROVIDER=modal` Actions secret and local `terraform.tfvars`. Merging the change to `main`
starts the normal Terraform deployment; opening the PR does not switch the running worker.

## Configuration

| Setting                                 | Source                                                      | Value                                          |
| --------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `sandbox_provider` / `SANDBOX_PROVIDER` | Tracked Terraform configuration                             | `daytona`                                      |
| `daytona_api_url` / `DAYTONA_API_URL`   | Tracked Terraform configuration                             | `https://app.daytona.io/api`                   |
| `daytona_base_snapshot`                 | Tracked Terraform configuration                             | `watchdog-open-inspect` name prefix            |
| `DAYTONA_BASE_SNAPSHOT`                 | Terraform module output → worker                            | Prefix plus image source hash                  |
| `DAYTONA_API_KEY`                       | GitHub Actions repository secret → Terraform secret binding | Watchdog organization API key                  |
| `DAYTONA_TARGET`                        | Optional Actions variable                                   | Omitted to use the organization default region |

The API key needs sandbox read/write/delete and snapshot read/write/delete permissions. It stays out
of source control and sandbox environment variables. Existing repository secrets and model-provider
account credentials continue through the control plane's normal credential delivery path.

## Build and cutover

Terraform builds a base snapshot with the shared runtime manifest, bundled skills, OpenCode,
code-server, browser/VNC tools, and ttyd. The snapshot reserves 2 CPUs, 4 GiB memory, and 10 GiB
disk (the current Watchdog organization limit). Runtime and build input changes produce a new
snapshot name. The worker depends on a successful build, so a failed replacement does not remove its
current base snapshot. Retries reuse an already active snapshot; an existing failed or unfinished
snapshot blocks deployment until investigated. Previous snapshots are retained for rollback and
require periodic manual cleanup once unused.

The Daytona image includes PostgreSQL 17 server and client binaries. Repository setup can use them
without contacting PGDG from inside a network-restricted sandbox. Image verification initializes a
temporary database, starts it over a local Unix socket, runs a query, and removes it; no database
cluster is baked into the snapshot. The major version is owned by `sandbox-images/toolchain.json`.

Fatal runtime errors fail the affected queued and processing prompts instead of automatically
replaying them. A new prompt can retry after the startup issue is fixed. Startup failures count
toward the circuit breaker until the runtime connects successfully. Replacing a sandbox requires
successful provider cleanup; a failed or timed-out deletion retains the old handle and blocks
creation so the session cannot accumulate orphaned sandboxes.

Before merging, finish active Modal sessions and push any work that must survive the provider
change. Modal filesystem snapshots and sandbox IDs cannot be resumed on Daytona. Start a new session
after cutover to validate repository checkout, agent streaming, terminal/IDE access, and
stop/resume. The existing integration uses persistent Daytona sandboxes; repository and environment
image builds and Modal-style session snapshots are unavailable on this backend.

No Modal application or credentials are explicitly deleted by this change. Terraform stops managing
its deployment resource when Daytona is selected. Retire the old Modal application only after the
new sessions have been verified.

## Verification and rollback

```bash
PYTHONPATH=packages/daytona-infra packages/sandbox-runtime/.venv/bin/pytest packages/daytona-infra/tests -q
terraform -chdir=terraform/environments/production test
npm test -w @open-inspect/control-plane -- src/sandbox/daytona-rest-client.test.ts src/sandbox/providers/daytona-provider.test.ts src/sandbox/provider-factory.test.ts
```

To roll back through CI, change `sandbox_provider` in the tracked cutover file to `modal` in a PR
and merge it. Keep the existing Modal Actions secrets until this migration is verified. For a
deliberate local deployment, a command-line `-var='sandbox_provider=modal'` overrides the tracked
file; changing only an Actions variable does not. Daytona filesystem state does not transfer back to
Modal; push work before either switch.

Daytona documents the underlying
[snapshot builds](https://www.daytona.io/docs/en/python-sdk/sync/snapshot/) and
[persistent sandbox lifecycle](https://www.daytona.io/docs/en/persistence/).
