# Watchdog Daytona deployment

Watchdog production selects Daytona in `terraform/environments/production/sandbox.auto.tfvars`. This
non-secret configuration is reviewed with the code and takes precedence over the old
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
code-server, browser/VNC tools, and ttyd. The snapshot reserves 2 CPUs, 4 GiB memory, and 20 GiB
disk. Runtime and build input changes produce a new snapshot name. The worker depends on a
successful build, so a failed replacement does not remove its current base snapshot. Retries reuse
an already active snapshot; an existing failed or unfinished snapshot blocks deployment until
investigated. Previous snapshots are retained for rollback and require periodic manual cleanup once
unused.

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
