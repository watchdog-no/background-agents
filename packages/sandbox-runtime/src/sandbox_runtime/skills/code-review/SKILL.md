---
name: code-review
description:
  Codex-style structured code review for local diffs and GitHub pull requests. Use when the user
  asks for /code-review, a code review, PR review, review comments, or prioritized P1-P3 findings.
  Dry-runs by default; posts GitHub PR reviews only when explicitly requested.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# Code Review

Use this skill as a local, Codex-style counterpart to native `/review`.

Core contract:

- Do not edit files.
- Do not browse the web.
- Do not post GitHub comments unless the invocation clearly asks to post/submit/leave a PR review or
  includes `--post`.
- Produce a structured Codex review result first, then render or post it.
- Review only bugs introduced by the selected diff.

## Invocation

Interpret `/code-review <args>` with this CLI-like contract:

```text
/code-review [--staged | --unstaged | --range <range> | --base <branch> | --pr <number>] [--post | --dry-run] [--post-approve] [instructions...]
```

Bare non-flag text is review focus and posting intent, not a diff range. Examples:

- `/code-review focus on auth edge cases`
- `/code-review --staged`
- `/code-review --base release/2026-05`
- `/code-review --range HEAD~3..HEAD focus on migrations`
- `/code-review --pr 123 --post focus on data loss`
- `/code-review --pr 123 post a review on the PR`

## Workflow

1. Resolve the target:

   ```bash
   SKILL_DIR=.opencode/skills/code-review
   python3 "$SKILL_DIR/scripts/resolve_review_target.py" <args>
   ```

   The resolver prints JSON with the diff command, log command, PR metadata, posting flags, and a
   Codex-style target prompt. Run the returned `diff_command` and read the patch. If it is empty,
   stop and say there are no changes to review.

2. Load the review rubric:
   - Read `references/codex_review_prompt.md`.
   - Read `references/review_contract.md` only when you need the exact schema or posting rules.

3. Review the diff and output exactly one JSON object matching `ReviewOutputEvent`:

   ```json
   {
     "findings": [],
     "overall_correctness": "patch is correct",
     "overall_explanation": "No blocking correctness issues were found.",
     "overall_confidence_score": 0.84
   }
   ```

   Do not wrap the JSON in markdown. Each finding must include an absolute file path and a line
   range that overlaps the diff.

4. Render the local response:

   ```bash
   python3 "$SKILL_DIR/scripts/render_review.py" < review.json
   ```

   Return the rendered Markdown to the user, not the raw JSON.

5. Post only when requested:

   If and only if the resolved target has `"post": true`, run:

   ```bash
   python3 "$SKILL_DIR/scripts/post_github_review.py" \
     --pr <number> \
     --review-json review.json
   ```

   Use the posting script's `--dry-run` first when checking the payload. Never post for `--staged`,
   `--unstaged`, `--range`, or `--base` unless a PR number was also resolved.

## Review Target Defaults

The resolver follows these defaults:

- If the current branch has one open GitHub PR, review that PR.
- Otherwise review the current branch against `main` using the merge base.
- `--staged`, `--unstaged`, `--range`, `--base`, and `--pr` override the default.
- Posting is enabled by `--post` or clear natural-language intent such as "post a review on the PR",
  "submit a PR review", "leave review comments", or "comment on the PR".
- Negations and dry-run language win: "do not post", "without posting", `--dry-run`, and `--no-post`
  all keep local output only.
- If posting intent is ambiguous, keep dry-run behavior.
- Posting intent without a resolvable PR is an error.

## Priority Rules

- `[P0]`: blocks release, operations, or major usage. Use only for universal issues.
- `[P1]`: urgent, should be addressed next.
- `[P2]`: normal, should be fixed eventually.
- `[P3]`: low priority, nice to have.

For GitHub posting, P0/P1 findings request changes; P2/P3-only reviews use a comment event. Approval
is only allowed for zero findings plus `--post-approve`.

## Codebase-Specific Checks

When relevant, treat these Open-Inspect invariants as review criteria:

- Build `@open-inspect/shared` before consumers when shared types change.
- Use seconds in Python and milliseconds in TypeScript; encode units in names.
- Define each default exactly once and import it.
- Do not check in `wrangler.toml`; control-plane config comes from Terraform.
- Cloudflare GitHub App private keys must be PKCS#8.
- Deploy Modal through `deploy.py` or `modal deploy -m src`, not `src/app.py` directly.
