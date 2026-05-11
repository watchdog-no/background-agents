#!/usr/bin/env python3
"""Resolve /code-review arguments into a concrete diff target."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

CommandRunner = Callable[[list[str], Path], str]

NEGATIVE_POST_RE = re.compile(
    r"\b(?:do\s+not|don't|dont|never|no)\s+"
    r"(?:post|submit|publish|leave|add|create|comment)\b"
    r"|\b(?:without|skip)\s+(?:posting|submitting|publishing|commenting)\b"
    r"|\b(?:dry[-\s]?run|dry output|local only)\b",
    re.IGNORECASE,
)
POSITIVE_POST_PATTERNS = [
    re.compile(
        r"\b(?:post|submit|publish)\s+(?:a\s+)?"
        r"(?:(?:pr|pull request)\s+)?review\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bleave\s+(?:a\s+)?(?:(?:pr|pull request)\s+)?review\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:post|submit|publish|leave|add|create)\s+"
        r"(?:inline\s+)?(?:review\s+)?comments?\s+"
        r"(?:on|to|for)\s+(?:the\s+)?(?:pr|pull request|github)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bcomment\s+on\s+(?:the\s+)?(?:pr|pull request)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\brequest\s+changes\s+(?:on|for)\s+(?:the\s+)?(?:pr|pull request)\b",
        re.IGNORECASE,
    ),
]


def run_text(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()


def run_json(command: list[str], cwd: Path, runner: CommandRunner) -> dict[str, Any]:
    return json.loads(runner(command, cwd))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="Review staged changes")
    parser.add_argument("--unstaged", action="store_true", help="Review unstaged changes")
    parser.add_argument("--range", dest="range_spec", help="Review git diff <range>")
    parser.add_argument("--base", default=None, help="Review current branch against base branch")
    parser.add_argument("--pr", type=int, help="Review a GitHub pull request")
    parser.add_argument("--post", action="store_true", help="Post review to GitHub")
    parser.add_argument(
        "--dry-run",
        "--no-post",
        dest="dry_run",
        action="store_true",
        help="Force local output and do not post to GitHub",
    )
    parser.add_argument(
        "--post-approve",
        action="store_true",
        help="Allow APPROVE when posting a zero-finding review",
    )
    parsed, instructions = parser.parse_known_args(argv)
    if instructions and instructions[0] == "--":
        instructions = instructions[1:]
    parsed.instructions = " ".join(instructions).strip()
    return parsed


def infer_post_intent(instructions: str) -> tuple[bool, str]:
    if not instructions:
        return False, "default"
    if NEGATIVE_POST_RE.search(instructions):
        return False, "dry_run"
    if any(pattern.search(instructions) for pattern in POSITIVE_POST_PATTERNS):
        return True, "instructions"
    return False, "default"


def selected_target_count(args: argparse.Namespace) -> int:
    return sum(
        bool(value) for value in [args.staged, args.unstaged, args.range_spec, args.base, args.pr]
    )


def current_branch_pr(cwd: Path, runner: CommandRunner) -> dict[str, Any] | None:
    command = [
        "gh",
        "pr",
        "view",
        "--json",
        "number,baseRefName,headRefName,headRefOid,title,url",
    ]
    try:
        return run_json(command, cwd, runner)
    except Exception:
        return None


def pr_metadata(number: int, cwd: Path, runner: CommandRunner) -> dict[str, Any]:
    command = [
        "gh",
        "pr",
        "view",
        str(number),
        "--json",
        "number,baseRefName,headRefName,headRefOid,title,url",
    ]
    return run_json(command, cwd, runner)


def merge_base(base_branch: str, cwd: Path, runner: CommandRunner) -> str | None:
    try:
        return runner(["git", "merge-base", "HEAD", base_branch], cwd).strip() or None
    except Exception:
        return None


def default_base_branch(cwd: Path, runner: CommandRunner) -> str:
    try:
        remote_head = runner(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
            cwd,
        )
        return remote_head.removeprefix("origin/").strip() or "main"
    except Exception:
        return "main"


def with_instructions(prompt: str, instructions: str) -> str:
    if not instructions:
        return prompt
    return f"{prompt}\n\nAdditional review instructions: {instructions}"


def base_target(
    base_branch: str, cwd: Path, runner: CommandRunner, instructions: str
) -> dict[str, Any]:
    base_sha = merge_base(base_branch, cwd, runner)
    if base_sha:
        prompt = (
            f"Review the code changes against the base branch '{base_branch}'. "
            f"The merge base commit for this comparison is {base_sha}. "
            f"Run `git diff {base_sha}` to inspect the changes relative to {base_branch}. "
            "Provide prioritized, actionable findings."
        )
        diff_command = ["git", "diff", base_sha]
        log_command = ["git", "log", "--oneline", f"{base_sha}..HEAD"]
    else:
        prompt = (
            f"Review the code changes against the base branch '{base_branch}'. "
            f"Start by finding the merge diff between the current branch and {base_branch}'s "
            "upstream, then run git diff against that SHA. Provide prioritized, actionable findings."
        )
        diff_command = ["git", "diff", f"{base_branch}...HEAD"]
        log_command = ["git", "log", "--oneline", f"{base_branch}..HEAD"]
    return {
        "target_type": "base",
        "base_branch": base_branch,
        "merge_base_sha": base_sha,
        "diff_command": diff_command,
        "log_command": log_command,
        "review_prompt": with_instructions(prompt, instructions),
    }


def resolve_review_target(
    argv: list[str] | None = None,
    *,
    cwd: Path | None = None,
    runner: CommandRunner = run_text,
) -> dict[str, Any]:
    cwd = cwd or Path.cwd()
    args = parse_args(argv)
    if args.post and args.dry_run:
        raise SystemExit("choose only one of --post or --dry-run/--no-post")
    if selected_target_count(args) > 1:
        raise SystemExit("choose only one of --staged, --unstaged, --range, --base, or --pr")

    target: dict[str, Any]
    if args.staged:
        target = {
            "target_type": "staged",
            "diff_command": ["git", "diff", "--cached"],
            "log_command": None,
            "review_prompt": with_instructions(
                "Review the staged code changes and provide prioritized findings.",
                args.instructions,
            ),
        }
    elif args.unstaged:
        target = {
            "target_type": "unstaged",
            "diff_command": ["git", "diff"],
            "log_command": None,
            "review_prompt": with_instructions(
                "Review the unstaged code changes and provide prioritized findings.",
                args.instructions,
            ),
        }
    elif args.range_spec:
        target = {
            "target_type": "range",
            "range": args.range_spec,
            "diff_command": ["git", "diff", args.range_spec],
            "log_command": ["git", "log", "--oneline", args.range_spec],
            "review_prompt": with_instructions(
                f"Review the code changes in git diff {args.range_spec}. "
                "Provide prioritized, actionable findings.",
                args.instructions,
            ),
        }
    elif args.base:
        target = base_target(args.base, cwd, runner, args.instructions)
    elif args.pr:
        metadata = pr_metadata(args.pr, cwd, runner)
        target = {
            "target_type": "pr",
            "pr": metadata,
            "diff_command": ["gh", "pr", "diff", str(args.pr), "--patch"],
            "log_command": None,
            "review_prompt": with_instructions(
                f"Review pull request #{args.pr}. Run `gh pr diff {args.pr} --patch` "
                "to inspect the changes. Provide prioritized, actionable findings.",
                args.instructions,
            ),
        }
    else:
        metadata = current_branch_pr(cwd, runner)
        if metadata:
            number = int(metadata["number"])
            target = {
                "target_type": "pr",
                "pr": metadata,
                "diff_command": ["gh", "pr", "diff", str(number), "--patch"],
                "log_command": None,
                "review_prompt": with_instructions(
                    f"Review pull request #{number}. Run `gh pr diff {number} --patch` "
                    "to inspect the changes. Provide prioritized, actionable findings.",
                    args.instructions,
                ),
            }
        else:
            target = base_target(default_base_branch(cwd, runner), cwd, runner, args.instructions)

    inferred_post, post_source = infer_post_intent(args.instructions)
    post = bool(args.post or (inferred_post and not args.dry_run))
    if args.post:
        post_source = "flag"
    elif args.dry_run:
        post_source = "dry_run"

    pr_number = target.get("pr", {}).get("number")
    if post and not pr_number:
        raise SystemExit("posting requires --pr or a current branch with an open PR")

    target.update(
        {
            "instructions": args.instructions,
            "post": post,
            "post_source": post_source,
            "post_approve": bool(args.post_approve),
        }
    )
    return target


def main(argv: list[str] | None = None) -> int:
    result = resolve_review_target(argv)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(error, file=sys.stderr)
        raise SystemExit(error.returncode)
