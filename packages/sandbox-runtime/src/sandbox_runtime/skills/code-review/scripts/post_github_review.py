#!/usr/bin/env python3
"""Post a validated Codex-style review JSON object to a GitHub PR."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from review_utils import (
    compact_location,
    format_finding_title,
    parse_review_output,
    priority_number,
)

HUNK_RE = re.compile(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def run(command: list[str], *, cwd: Path | None = None) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def gh_json(command: list[str]) -> dict[str, Any]:
    return json.loads(run(command))


def read_review_json(path: str) -> dict[str, Any]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    output, parse_error = parse_review_output(text, allow_fallback=False)
    if parse_error:
        raise ValueError(parse_error)
    return output


def repo_root() -> Path:
    return Path(run(["git", "rev-parse", "--show-toplevel"])).resolve()


def repo_name_with_owner() -> str:
    return str(gh_json(["gh", "repo", "view", "--json", "nameWithOwner"])["nameWithOwner"])


def collect_commentable_lines(diff_text: str) -> dict[str, set[int]]:
    lines_by_path: dict[str, set[int]] = {}
    current_path: str | None = None
    new_line: int | None = None

    for line in diff_text.splitlines():
        if line.startswith("+++ b/"):
            current_path = line[len("+++ b/") :]
            lines_by_path.setdefault(current_path, set())
            new_line = None
            continue
        if line.startswith("@@"):
            match = HUNK_RE.match(line)
            if match:
                new_line = int(match.group(1))
            continue
        if current_path is None or new_line is None:
            continue
        if (line.startswith("+") and not line.startswith("+++")) or line.startswith(" "):
            lines_by_path[current_path].add(new_line)
            new_line += 1
        elif (line.startswith("-") and not line.startswith("---")) or line.startswith("\\"):
            continue

    return lines_by_path


def relative_repo_path(path: str, root: Path) -> str:
    root = root.resolve()
    raw_path = Path(path)
    if raw_path.is_absolute():
        try:
            return raw_path.resolve().relative_to(root).as_posix()
        except ValueError:
            return raw_path.as_posix().lstrip("/")
    return raw_path.as_posix()


def first_commentable_line(
    finding: dict[str, Any],
    relative_path: str,
    commentable_lines: dict[str, set[int]],
) -> int | None:
    available = commentable_lines.get(relative_path, set())
    line_range = finding["code_location"]["line_range"]
    for line in range(line_range["start"], line_range["end"] + 1):
        if line in available:
            return line
    return None


def review_event(output: dict[str, Any], *, post_approve: bool) -> str:
    findings = output.get("findings", [])
    if not findings:
        return "APPROVE" if post_approve else "COMMENT"
    for finding in findings:
        priority = priority_number(finding)
        if priority is not None and priority <= 1:
            return "REQUEST_CHANGES"
    return "COMMENT"


def comment_body(finding: dict[str, Any]) -> str:
    return f"{format_finding_title(finding)}\n\n{str(finding['body']).strip()}"


def review_body(output: dict[str, Any], unposted: list[dict[str, Any]]) -> str:
    body = str(output.get("overall_explanation", "")).strip() or "Review complete."
    if not unposted:
        return body
    lines = [body, "", "Unposted findings:"]
    for finding in unposted:
        lines.append("")
        lines.append(f"- {format_finding_title(finding)} ({compact_location(finding)})")
        lines.append(f"  {str(finding['body']).strip()}")
    return "\n".join(lines)


def build_review_payload(
    output: dict[str, Any],
    *,
    root: Path,
    diff_text: str,
    head_sha: str,
    post_approve: bool = False,
) -> dict[str, Any]:
    commentable_lines = collect_commentable_lines(diff_text)
    comments: list[dict[str, Any]] = []
    unposted: list[dict[str, Any]] = []

    for finding in output.get("findings", []):
        rel_path = relative_repo_path(finding["code_location"]["absolute_file_path"], root)
        line = first_commentable_line(finding, rel_path, commentable_lines)
        if line is None:
            unposted.append(finding)
            continue
        comments.append(
            {
                "path": rel_path,
                "line": line,
                "side": "RIGHT",
                "body": comment_body(finding),
            }
        )

    return {
        "commit_id": head_sha,
        "event": review_event(output, post_approve=post_approve),
        "body": review_body(output, unposted),
        "comments": comments,
    }


def submit_review(name_with_owner: str, pr_number: int, payload: dict[str, Any]) -> str:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        json.dump(payload, handle)
        payload_path = handle.name
    try:
        return run(
            [
                "gh",
                "api",
                f"repos/{name_with_owner}/pulls/{pr_number}/reviews",
                "--method",
                "POST",
                "--input",
                payload_path,
            ]
        )
    finally:
        Path(payload_path).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, required=True, help="Pull request number")
    parser.add_argument("--review-json", required=True, help="Review JSON file, or - for stdin")
    parser.add_argument(
        "--post-approve", action="store_true", help="Allow APPROVE on zero findings"
    )
    parser.add_argument("--dry-run", action="store_true", help="Print payload without posting")
    args = parser.parse_args(argv)

    output = read_review_json(args.review_json)
    pr = gh_json(
        [
            "gh",
            "pr",
            "view",
            str(args.pr),
            "--json",
            "headRefOid,number,title,url",
        ]
    )
    diff_text = run(["gh", "pr", "diff", str(args.pr), "--patch"])
    payload = build_review_payload(
        output,
        root=repo_root(),
        diff_text=diff_text,
        head_sha=str(pr["headRefOid"]),
        post_approve=args.post_approve,
    )

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    run(["gh", "auth", "status"])
    print(submit_review(repo_name_with_owner(), args.pr, payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
