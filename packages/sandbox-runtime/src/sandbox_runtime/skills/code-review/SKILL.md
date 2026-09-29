---
name: code-review
description:
  Review local Git changes or a GitHub PR for actionable bugs introduced by the diff. Use for
  /code-review or explicit code review requests.
metadata:
  workflow: github-pr-review
---

# Code Review

Review a selected Git diff without editing files. Apply the newer Codex app's review rubric,
including repository-rule attribution, while preserving JSON transport for local rendering and
GitHub posting.

## Resolve the Target

Run from the reviewed repository root. Set `SKILL_DIR` to the directory containing the loaded
`SKILL.md`, wherever the agent has installed or discovered this skill.

```bash
SKILL_DIR=/absolute/path/to/code-review
python3 "$SKILL_DIR/scripts/resolve_review_target.py" <args>
```

Translate natural-language scope and posting intent into arguments once:

```text
/code-review [--uncommitted | --staged | --unstaged | --commit <sha> | --range <range> | --base <branch> | --pr <number>] [--post | --dry-run] [--post-approve] [instructions...]
```

Bare text is review focus or posting intent, not a diff range. Explicit scope overrides defaults.
The default reviews the current branch's open PR when available, otherwise the branch against the
repository's default branch using its merge base. Use `--uncommitted` for staged, unstaged, and
untracked files, including a repository with no commits yet.

Examples:

- `/code-review --uncommitted focus on auth edge cases`
- `/code-review --commit HEAD`
- `/code-review --base release/2026-05`
- `/code-review --pr 123 --post focus on data loss`

## Review

1. Run the resolver. It returns command argument arrays, a target prompt, and posting flags. For PR
   targets, retain `pr.headRefOid` as the reviewed revision.
2. Execute every command in `diff_commands`. If `untracked_command` is present, run it too: its
   output is NUL-delimited paths to new files, whose contents must be read separately. Branch
   reviews include staged, unstaged, and untracked changes alongside changes since the merge base.
   Declare the scope empty only when all selected diffs and untracked files are empty.
3. Read [the review rubric](references/codex_review_prompt.md) and
   [the output contract](references/review_contract.md). Load applicable project instructions and
   their required documents for the changed files; use those current rules as review criteria.
4. When delegation is available and useful, give one reviewer the complete target prompt, rubric,
   output contract, and relevant repository instructions. Include the selected diff commands and
   untracked-file scope. Reuse an active review of the same changes. Keep the review read-only and
   have the reviewer return its findings; perform the same review locally when delegation is
   unavailable. Follow the rubric's bounds for any further focused investigators.
5. Review only bugs introduced by the selected changes. Verify each finding's scenario, affected
   behavior, location, and rule references, and merge duplicate findings. Produce one JSON object
   matching the output contract in `review.json`, preferably in a temporary directory outside the
   working tree.
6. Render the user-facing Markdown:

   ```bash
   python3 "$SKILL_DIR/scripts/render_review.py" < review.json
   ```

   In a client supporting Codex inline comments, add `--inline-comments` to emit `::code-comment`
   directives alongside Markdown. Invalid review output is an error; correct it before rendering or
   posting.

Keep findings concise and grounded in evidence. Follow project instructions for tool choice and
verification. Review alone does not authorize edits, fixes, Git changes, or external comments.

## Post Only When Requested

The resolver enables posting for `--post` or clear intent such as "post a review on the PR".
Negations and dry-run language override posting intent. Ambiguous intent keeps output local. Posting
requires a resolved PR target; other local scopes do not post.

For a target with `post: true`, build and inspect the payload first:

```bash
python3 "$SKILL_DIR/scripts/post_github_review.py" \
  --pr <number> --head-sha <pr.headRefOid> --review-json review.json --dry-run
```

Then run the same command without `--dry-run`. Forward `--post-approve` only when the resolver's
`post_approve` flag is true. The script rejects a changed PR head; resolve and review the new
revision before retrying.

P0/P1 findings request changes; P2/P3-only reviews leave a comment. Approval requires explicit
`--post-approve`, zero findings, and a `patch is correct` verdict. Rule citations remain visible in
finding bodies; do not add hidden attribution metadata.
