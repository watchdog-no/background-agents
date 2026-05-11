#!/usr/bin/env python3
"""Render Codex-style review JSON as Markdown."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from review_utils import parse_review_output, render_markdown


def read_input(path: str | None) -> str:
    if not path or path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("review_json", nargs="?", default="-", help="Review JSON file, or stdin")
    args = parser.parse_args(argv)

    output, parse_error = parse_review_output(read_input(args.review_json))
    if parse_error:
        print(f"warning: structured review parsing failed: {parse_error}", file=sys.stderr)
    print(render_markdown(output), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
