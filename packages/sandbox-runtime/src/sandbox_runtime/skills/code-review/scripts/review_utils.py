#!/usr/bin/env python3
"""Shared helpers for the code-review skill."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

CORRECTNESS_VALUES = {"patch is correct", "patch is incorrect"}
PRIORITY_RE = re.compile(r"^\[(P[0-3])\]\s*(.*)$")


class ReviewValidationError(ValueError):
    """Raised when review output does not match the Codex review contract."""


def _require_mapping(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReviewValidationError(f"{context} must be an object")
    return value


def _require_string(value: Any, context: str) -> str:
    if not isinstance(value, str):
        raise ReviewValidationError(f"{context} must be a string")
    return value


def _require_score(value: Any, context: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise ReviewValidationError(f"{context} must be a number")
    score = float(value)
    if score < 0.0 or score > 1.0:
        raise ReviewValidationError(f"{context} must be between 0.0 and 1.0")
    return score


def _require_line(value: Any, context: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ReviewValidationError(f"{context} must be a positive integer")
    return value


def validate_review_output(value: Any) -> dict[str, Any]:
    output = _require_mapping(value, "review output")

    findings = output.get("findings")
    if not isinstance(findings, list):
        raise ReviewValidationError("findings must be an array")

    for index, raw_finding in enumerate(findings):
        context = f"findings[{index}]"
        finding = _require_mapping(raw_finding, context)
        _require_string(finding.get("title"), f"{context}.title")
        _require_string(finding.get("body"), f"{context}.body")
        _require_score(finding.get("confidence_score"), f"{context}.confidence_score")

        priority = finding.get("priority")
        if priority is not None:
            if (
                not isinstance(priority, int)
                or isinstance(priority, bool)
                or priority not in range(4)
            ):
                raise ReviewValidationError(f"{context}.priority must be 0, 1, 2, 3, or null")

        location = _require_mapping(finding.get("code_location"), f"{context}.code_location")
        path = _require_string(
            location.get("absolute_file_path"),
            f"{context}.code_location.absolute_file_path",
        )
        if not Path(path).is_absolute():
            raise ReviewValidationError(
                f"{context}.code_location.absolute_file_path must be absolute"
            )

        line_range = _require_mapping(
            location.get("line_range"),
            f"{context}.code_location.line_range",
        )
        start = _require_line(line_range.get("start"), f"{context}.line_range.start")
        end = _require_line(line_range.get("end"), f"{context}.line_range.end")
        if end < start:
            raise ReviewValidationError(f"{context}.line_range.end must be >= start")

    correctness = _require_string(output.get("overall_correctness"), "overall_correctness")
    if correctness not in CORRECTNESS_VALUES:
        raise ReviewValidationError(
            "overall_correctness must be 'patch is correct' or 'patch is incorrect'"
        )
    _require_string(output.get("overall_explanation"), "overall_explanation")
    _require_score(output.get("overall_confidence_score"), "overall_confidence_score")
    return output


def parse_review_output(
    text: str, *, allow_fallback: bool = True
) -> tuple[dict[str, Any], str | None]:
    try:
        return validate_review_output(json.loads(text)), None
    except (json.JSONDecodeError, ReviewValidationError) as first_error:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            try:
                return validate_review_output(json.loads(text[start : end + 1])), None
            except (json.JSONDecodeError, ReviewValidationError):
                pass
        if not allow_fallback:
            raise ReviewValidationError(str(first_error)) from first_error
        return (
            {
                "findings": [],
                "overall_correctness": "patch is incorrect",
                "overall_explanation": text.strip() or "Reviewer failed to output a response.",
                "overall_confidence_score": 0.0,
            },
            str(first_error),
        )


def priority_number(finding: dict[str, Any]) -> int | None:
    priority = finding.get("priority")
    if isinstance(priority, int) and not isinstance(priority, bool) and priority in range(4):
        return priority
    match = PRIORITY_RE.match(str(finding.get("title", "")))
    if match:
        return int(match.group(1)[1])
    return None


def priority_label(finding: dict[str, Any]) -> str:
    priority = priority_number(finding)
    if priority is None:
        return "P3"
    return f"P{priority}"


def format_finding_title(finding: dict[str, Any]) -> str:
    title = str(finding.get("title", "")).strip()
    if PRIORITY_RE.match(title):
        return title
    return f"[{priority_label(finding)}] {title}"


def bare_title(finding: dict[str, Any]) -> str:
    """Return the finding title without its leading [P0]-[P3] tag."""
    title = str(finding.get("title", "")).strip()
    match = PRIORITY_RE.match(title)
    return match.group(2).strip() if match else title


def compact_location(finding: dict[str, Any]) -> str:
    location = finding["code_location"]
    line_range = location["line_range"]
    start = line_range["start"]
    end = line_range["end"]
    suffix = f"{start}" if start == end else f"{start}-{end}"
    return f"{location['absolute_file_path']}:{suffix}"


def render_markdown(output: dict[str, Any]) -> str:
    lines: list[str] = []
    findings = output.get("findings", [])

    explanation = str(output.get("overall_explanation", "")).strip()
    if explanation:
        lines.append(explanation)
        lines.append("")

    if findings:
        lines.append("Review comment:" if len(findings) == 1 else "Full review comments:")
        lines.append("")
        for finding in findings:
            lines.append(f"### {format_finding_title(finding)}")
            lines.append("")
            lines.append(f"**File:** `{compact_location(finding)}`")
            lines.append(f"**Confidence:** {float(finding['confidence_score']):.2f}")
            lines.append("")
            lines.append(str(finding["body"]).strip())
            lines.append("")
    else:
        lines.append("No findings.")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(f"**Overall correctness:** `{output['overall_correctness']}`")
    lines.append(f"**Confidence:** {float(output['overall_confidence_score']):.2f}")
    if explanation:
        lines.append(f"**Explanation:** {explanation}")
    return "\n".join(lines).rstrip() + "\n"
