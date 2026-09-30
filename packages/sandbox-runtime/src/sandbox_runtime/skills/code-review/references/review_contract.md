# Review Contract

The skill uses the newer Codex app's review guidance with a JSON transport format for its scripts.
The app itself produces Markdown and inline comment directives. Keep presentation separate from this
transport contract so the same findings can be rendered locally or posted to GitHub.

## JSON Shape

The reviewer must output one JSON object:

```json
{
  "findings": [
    {
      "title": "[P1] Short title",
      "body": "One paragraph explaining why this is a bug and when it fires.",
      "confidence_score": 0.91,
      "priority": 1,
      "code_location": {
        "absolute_file_path": "/repo/path/file.ts",
        "line_range": { "start": 42, "end": 42 }
      }
    }
  ],
  "overall_correctness": "patch is incorrect",
  "overall_explanation": "The patch introduces a data-loss path.",
  "overall_confidence_score": 0.88
}
```

`overall_correctness` must be `patch is correct` or `patch is incorrect`.

## Finding Requirements

- `absolute_file_path` must be absolute.
- `line_range` is inclusive and must overlap the reviewed diff.
- For an untracked file, all its lines are additions; choose the relevant range from its contents.
- Keep the range short; choose the smallest changed or context range that makes the issue clear.
- `priority` is `0`, `1`, `2`, or `3`; omit or use `null` only when priority cannot be determined.
- The `title` should include `[P0]`, `[P1]`, `[P2]`, or `[P3]`.
- The body is one Markdown paragraph and should explain the concrete failure mode.
- Numeric priority and the title's priority label must agree.
- A finding supported by a repository rule cites the applicable instruction file and its smallest
  supporting line range in the body. Deduplicate findings and preserve their rule references.
- Include checks performed and material verification limits in `overall_explanation` when relevant.

## Local Rendering

Local `/code-review` renders JSON into concise Markdown with `scripts/render_review.py`. The
rendered output is what the user should see. Invalid output exits with an error and is never shown
as an empty review. Confidence and correctness fields remain in the transport; the explanation and
actionable findings are the visible response.

Add `--inline-comments` in a client supporting Codex directives to emit one `::code-comment` for
each finding. Required attributes are `title`, `body`, and `file`; the renderer also includes the
selected `start`, `end`, and `priority`. Rule citations stay in the visible body.

## GitHub Posting

Posting is opt-in only. Pass `--head-sha <pr.headRefOid>` from the resolved review target; the
script rejects a changed PR head before building or submitting the review. `--dry-run` prints the
payload without posting. `scripts/post_github_review.py` builds one GitHub review:

- P0/P1 findings -> `REQUEST_CHANGES`.
- P2/P3-only findings -> `COMMENT`.
- Zero findings -> `COMMENT`; `APPROVE` additionally requires `--post-approve` and
  `patch is correct`.

Inline comments are posted only when the file and RIGHT-side line are commentable in the PR diff.
Unpostable findings are moved into the review body.
