---
name: code-review
description:
  Strict, prioritized code review of a code change. Modeled on OpenAI Codex's review prompt
  (https://github.com/openai/codex/blob/main/codex-rs/core/review_prompt.md). Use when the user
  asks for a code review, a PR review, or "review the changes". Reviews the current branch's diff
  vs `main` by default; an optional argument can override the diff range.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
---

# Code Review (Codex-style)

You are acting as a reviewer for a proposed code change made by another engineer.

## Step 1 — resolve the diff to review

The skill takes an optional `args` string. Interpret it as a git diff range:

- **No args** → `git diff main...HEAD` (everything on the current branch since it diverged from
  `main`). Use the three-dot form so reverted upstream changes don't show up as the reviewer's work.
- **`staged`** → `git diff --cached`.
- **`unstaged`** → `git diff`.
- **A commit-ish or range** (e.g. `HEAD~3`, `abc123..HEAD`, `main..feat/foo`) → use it verbatim with
  `git diff <range>`.

Run the diff command first and read the patch. If the diff is empty, tell the user and stop.

Also run `git log --oneline <range>` for the same range so you can attribute changes to commits.

## Step 2 — review against these guidelines

These are general guidelines for deciding whether something is a bug worth flagging. Specific
guidance in `CLAUDE.md`, `WATCHDOG.md`, or developer messages overrides these.

A finding qualifies as a bug if **all** of the following are true:

1. It meaningfully impacts accuracy, performance, security, or maintainability.
2. The bug is discrete and actionable — not a vague systemic complaint.
3. Fixing it doesn't demand more rigor than the rest of the codebase already shows.
4. The bug was **introduced in this diff** — pre-existing bugs are not in scope.
5. The original author would likely fix it if made aware.
6. The bug does not rely on unstated assumptions about the codebase or author's intent.
7. If you claim a change disrupts other code, identify the affected code by file:line. Speculation
   is not enough.
8. The change is clearly not just an intentional choice by the author.

**How many findings:** report every qualifying finding — don't stop at the first. If nothing
qualifies, return zero findings and say so explicitly.

**Trivial style:** ignore unless it obscures meaning or violates a documented standard.

## Step 3 — write findings

For each finding, produce a markdown section in this exact shape:

```markdown
### [P{0|1|2|3}] <≤80 char imperative title>

**File:** `<absolute_path>:<start_line>` (or `<start>-<end>` for a multi-line range)
**Confidence:** <0.0–1.0>

<One paragraph explaining *why* this is a bug. Reference files/lines/functions. Spell out the
inputs, environments, or scenarios required for the bug to occur — severity hinges on those.>

```suggestion
<concrete replacement code, exact leading whitespace preserved, no commentary inside the block>
```
```

The suggestion block is optional — include it only when there's a clean replacement that's at most
~3 lines. Don't introduce or remove outer indentation unless that *is* the fix. For longer fixes,
describe them in the paragraph instead.

**Priority tags:**

- `[P0]` — drop everything. Blocks release, ops, or major usage. Use only for universal issues
  that don't depend on assumptions about inputs.
- `[P1]` — urgent, should be addressed next.
- `[P2]` — normal, fix eventually.
- `[P3]` — nice-to-have.

**Comment style:**

- One paragraph per finding. No mid-sentence line breaks unless required for a code fragment.
- Inline code in backticks; never paste >3 lines of code outside a fenced block or suggestion.
- Matter-of-fact tone. Not accusatory, not flattering. No "Great job …", no "Thanks for …".
- State explicitly the conditions that make the bug fire — that's how the author judges urgency.
- Make it grok-on-first-read. If the author has to puzzle it out, rewrite the comment.

## Step 4 — overall verdict

After listing findings (or stating there are none), output a verdict block:

```markdown
---

**Overall correctness:** `patch is correct` | `patch is incorrect`
**Confidence:** <0.0–1.0>
**Explanation:** <1–3 sentences justifying the verdict. Cite the most load-bearing finding(s) if
incorrect; cite the absence of blocking issues if correct.>
```

`patch is correct` means existing code and tests won't break and the patch is free of bugs and
other blocking issues. Style nits, formatting, typos, and doc-only quibbles are **not** blocking
— ignore them when forming the verdict.

## Notes on this codebase

When relevant, weigh these `CLAUDE.md` invariants — violations are bugs, not nits:

- `@open-inspect/shared` must build before consumers. A diff that adds/changes a shared type
  without rebuilding consumers' assumptions is suspect.
- Durations use seconds in Python (`timeout_seconds`), milliseconds in TypeScript (`*_MS`); never
  bare `timeout`.
- Each default value defined once and imported — duplicated literals are a finding.
- `wrangler.toml` is generated by Terraform, not checked in.
- Cloudflare Worker GitHub App keys must be PKCS#8.
- Modal deploys via `deploy.py`, never `src/app.py`.

Skip any of the above that are irrelevant to the diff under review.
