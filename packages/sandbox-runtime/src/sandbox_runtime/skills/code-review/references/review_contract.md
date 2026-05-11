# Review Contract

The code-review skill mirrors Codex `/review` by separating structured review generation from
presentation.

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
- Keep the range short; choose the smallest changed or context range that makes the issue clear.
- `priority` is `0`, `1`, `2`, or `3`; omit or use `null` only when priority cannot be determined.
- The `title` should include `[P0]`, `[P1]`, `[P2]`, or `[P3]`.
- The body is one Markdown paragraph and should explain the concrete failure mode.

## Local Rendering

Local `/code-review` renders JSON into Markdown with `scripts/render_review.py`. The rendered output
is what the user should see in the terminal.

## GitHub Posting

Posting is opt-in only. `scripts/post_github_review.py` builds one GitHub review:

- P0/P1 findings -> `REQUEST_CHANGES`.
- P2/P3-only findings -> `COMMENT`.
- Zero findings -> `COMMENT`, unless `--post-approve` is present, then `APPROVE`.

Inline comments are posted only when the file and RIGHT-side line are commentable in the PR diff.
Unpostable findings are moved into the review body.
