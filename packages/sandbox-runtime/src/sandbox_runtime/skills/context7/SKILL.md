---
name: context7
description:
  Fetch current documentation, API references, and code examples for any library, framework, SDK,
  CLI tool, or cloud service via the `ctx7` (Context7) CLI. Use whenever a task involves a specific
  technology — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or
  Spring Boot — for API syntax, configuration options, version migration, setup instructions, CLI
  usage, or library-specific debugging. Use even when you think you know the answer; training data
  may be stale.
compatibility: opencode
metadata:
  workflow: docs
---

# Context7 (`ctx7`)

Use the `ctx7` command to pull up-to-date documentation instead of relying on training data, which
may not reflect recent API changes or version updates. Prefer this over web search for library docs.

Use for: API syntax questions, configuration options, version migration issues, "how do I" questions
mentioning a library name, debugging that involves library-specific behavior, setup instructions,
and CLI tool usage.

Do **not** use for: refactoring, writing scripts from scratch, debugging business logic, code
review, or general programming concepts.

## Start Here

`ctx7` works anonymously (rate-limited) — no login step needed for normal use. If a command fails
with a **quota error**, the user can raise the limits by setting a `CONTEXT7_API_KEY` secret in
**Settings → Secrets** (or by running `ctx7 login`). Don't silently fall back to training data on a
quota error — tell the user how to lift the limit.

## Two-step flow

Resolving a library id first, then fetching docs, gives far better results than guessing an id.

```bash
# 1. Resolve the library to a Context7 id (format: /org/project).
#    Use the official name with proper punctuation: "Next.js" not "nextjs".
ctx7 library "Next.js" "app router data fetching"

# 2. Fetch docs for the best-matching id, passing the full question as the required query.
ctx7 docs "/vercel/next.js" "app router data fetching"
```

When picking from `library` results, prefer: exact name match, description relevance, higher code
snippet count, reputable source, and higher benchmark score. If results look wrong, try an alternate
name or rephrase the question (e.g. "next.js" not "nextjs").

You **must** call `library` first to get a valid id, unless the user gave one directly in
`/org/project` format.

## Version-specific docs

Use a `/org/project/version` id from the `library` output:

```bash
ctx7 docs "/vercel/next.js/v14.3.0" "middleware configuration"
```

## Guidelines

- Use the user's full question as the query — specific, detailed queries return better results than
  vague single words.
- `ctx7 docs` requires both a library id and a query; do not omit the query.
- Run at most ~3 `ctx7` commands per question.
- Never include sensitive information (API keys, passwords, credentials) in queries.
