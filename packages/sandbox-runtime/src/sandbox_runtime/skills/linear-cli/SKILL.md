---
name: linear-cli
description:
  Read and write Linear (issues, comments, projects, cycles, milestones, documents) from the command
  line via the `linear` CLI. Use when the task references a Linear issue (e.g. WD-123), asks to
  search/create/update/comment on Linear issues, or needs Linear project or planning data.
compatibility: opencode
metadata:
  workflow: linear
---

# Linear CLI

Use the `linear` command (schpet/linear-cli) to read and mutate Linear data. Prefer the CLI's
structured subcommands over raw GraphQL; reach for `linear api` only for things the subcommands
don't cover.

## Start Here

The CLI authenticates from the `LINEAR_API_KEY` environment variable — no login step. Confirm access
before doing anything else:

```bash
linear team list
```

If this fails with an auth error, Linear access isn't configured for this session. Stop and tell the
user: either the Linear app hasn't been installed (OAuth) or no `LINEAR_API_KEY` secret is set in
**Settings → Secrets**. Don't try to work around it. (Avoid `linear auth whoami` as the check — it
resolves the current _user_, which an app-actor token doesn't have.)

> **Attribution:** writes (issues, comments, status changes) are attributed to whatever identity the
> credential represents — normally the Linear **app/integration** (when the workspace authorized the
> app), or the owner of a personal API key. Don't create or edit Linear data unless the task clearly
> calls for it.

## Output for agents

Pass `--json` on read commands and parse the result — don't scrape the human-formatted tables.

- `issue query` / `issue list` JSON is `{ "nodes": [ ... ], "pageInfo": {...} }`. Each node has
  `identifier`, `title`, `url`, `state`, `assignee`, `team`, `project`, `labels`, `priority`, etc.
- `issue view <ID> --json` returns a single issue object (`identifier`, `title`, `description`,
  `url`, `branchName`, `state`, `assignee`, `project`, `parent`, ...).

In the sandbox, also pass `--no-pager` so output isn't held in a pager.

## Reading

```bash
# Full-text search across all teams, structured output (the main read workhorse)
linear issue query --search "login bug" --all-teams --json --no-pager

# Filter instead of search: by state, team, assignee, label, project, recency
linear issue query --team WD --state started --label backend --json --no-pager
linear issue query --updated-after 2026-05-01 --json --no-pager

# A single issue by identifier, with its description and comments
linear issue view WD-123 --json --no-pager

# Comments on an issue
linear issue comment list WD-123 --json

# Reference data
linear team list
linear project list
```

Notes:

- `issue list` (alias `mine`) defaults to **your own unstarted** issues. For general lookups use
  `issue query`, which defaults to all states and supports `--all-teams`.
- `--search` and `--sort` can't be combined; with `--search`, results are relevance-ordered.

## Writing

Use **file-based flags** (`--description-file`, `--body-file`) for any markdown body — they avoid
shell-escaping mangling of newlines, backticks, and quotes. Always pass `--no-interactive` on
`create` so it never blocks on a prompt in the headless sandbox.

```bash
# Create an issue (write the body to a temp file first)
cat > /tmp/desc.md <<'EOF'
## Summary
Repro steps and context here.
EOF
linear issue create \
  --team WD \
  --title "Fix flaky login redirect" \
  --description-file /tmp/desc.md \
  --no-interactive
# add --assignee self, --priority 2, --label bug, --project "...", --state "Todo" as needed

# Update an existing issue (state accepts a workflow-state name or type)
linear issue update WD-123 --state "In Progress"
linear issue update WD-123 --assignee self --priority 2

# Comment on an issue (body from a file)
cat > /tmp/comment.md <<'EOF'
Opened PR with the fix; see linked branch.
EOF
linear issue comment add WD-123 --body-file /tmp/comment.md
# reply to a comment with --parent <commentId>; attach a file with --attach <path>
```

## Raw GraphQL (escape hatch)

For anything the subcommands don't expose. Pass variables with `--variable key=value` or
`--variables-json`, and use heredoc stdin for queries containing GraphQL non-null markers (`!`):

```bash
linear api --variable issueId=WD-123 <<'GRAPHQL'
query($issueId: String!) {
  issue(id: $issueId) { id title state { name } }
}
GRAPHQL
```

`linear schema` prints the full GraphQL schema if you need to discover fields.
