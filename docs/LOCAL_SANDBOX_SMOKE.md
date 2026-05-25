# Local Sandbox Smoke Harness

Use this when debugging OpenCode/sandbox-runtime behavior without deploying Modal or Cloudflare. It
is not a full local Open-Inspect stack; it runs only the part we usually need for runtime bugs:

```text
repo checkout -> runtime .opencode skills/tools -> opencode serve -> AgentBridge prompt path
```

The harness is useful for reproducing issues like repeated `skill(code-review)` tool calls before
any real repo work happens.

## Prerequisites

- `uv`
- `node` / `npm`
- `opencode` on `PATH`, or use `--opencode-version` to install a pinned copy in the smoke workdir
- a working OpenCode auth setup for the selected model
- access to the target repository

The default target is `watchdog-no/watchdog-monorepo`. If `WATCHDOG_MONOREPO_PATH` is set, or
`~/projects/watchdog/watchdog-monorepo` exists, the harness clones from that local checkout.
Otherwise it clones from GitHub.

## Clean Runtime Repro

From the repo root:

```bash
cd packages/sandbox-runtime

uv run python scripts/local_prompt_smoke.py \
  --force \
  --opencode-version 1.15.10
```

Defaults:

- prompt: `Please use the /code-review skill to review PR 658 in watchdog-monorepo.`
- model: `openai/gpt-5.5`
- reasoning effort: `xhigh`
- workdir: `/tmp/openinspect-local-smoke`

The script removes any repo `.opencode` directory before installing the bundled runtime
`.opencode/skills` and `.opencode/tools` directories, which mirrors a fresh sandbox checkout. It
also runs OpenCode with an isolated `HOME`, disables OpenCode autoupdate like production, copies
`~/.local/share/opencode/auth.json` into that home by default, and passes `gh auth token` as
`GH_TOKEN` so local user skills do not pollute the repro while PR metadata still resolves. When
cloning from a local checkout, it resets `origin` to `https://github.com/<owner>/<repo>.git` by
default so GitHub CLI commands see the same repository identity as production.

## Dirty/Generated `.opencode` Repro

To test whether pre-existing generated `.opencode` state changes behavior:

```bash
cd packages/sandbox-runtime

uv run python scripts/local_prompt_smoke.py \
  --force \
  --no-clean-opencode \
  --repo-source ~/projects/watchdog/watchdog-monorepo \
  --opencode-version 1.15.10
```

This preserves the cloned repo's `.opencode` content if the source has committed or copied state. In
normal `watchdog-monorepo` clones, `.opencode` is ignored and not committed, so the clean mode is
the production-like default.

## Failure Signal

The harness records every bridge event to:

```text
/tmp/openinspect-local-smoke/events.jsonl
```

OpenCode logs go to:

```text
/tmp/openinspect-local-smoke/opencode.log
```

Exit codes:

- `0`: prompt completed without hitting the configured loop guard
- `2`: repeated `skill(<name>)` calls exceeded the threshold before any non-skill tool call
- `3`: no non-skill tool call was observed while `--require-non-skill-tool` was enabled
- `4`: OpenCode or the bridge emitted an error event

The loop guard defaults to more than 3 `skill(code-review)` calls before any non-skill tool call.
Adjust it with:

```bash
--max-skill-calls-before-work 3
```

## Useful Variations

Run against the locally installed OpenCode binary:

```bash
uv run python scripts/local_prompt_smoke.py --force
```

Use a different prompt:

```bash
uv run python scripts/local_prompt_smoke.py \
  --force \
  --prompt "Review PR 651"
```

Use the OpenCode-hosted model as a control when local GPT auth is stale:

```bash
uv run python scripts/local_prompt_smoke.py \
  --force \
  --model opencode/big-pickle \
  --reasoning-effort high
```

Keep running after repeated skill calls and only record events:

```bash
uv run python scripts/local_prompt_smoke.py \
  --force \
  --no-stop-on-skill-loop \
  --no-require-non-skill-tool
```
