from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "sandbox_runtime"
    / "skills"
    / "code-review"
    / "scripts"
)
SKILL_FILE = SCRIPTS_DIR.parent / "SKILL.md"
sys.path.insert(0, str(SCRIPTS_DIR))

import post_github_review  # noqa: E402
import resolve_review_target  # noqa: E402
from review_utils import parse_review_output, render_markdown  # noqa: E402


def sample_output(path: str = "/repo/src/app.ts", *, priority: int = 1) -> dict:
    return {
        "findings": [
            {
                "title": f"[P{priority}] Preserve the saved token",
                "body": "When the refresh path runs, this overwrites the token before it is used.",
                "confidence_score": 0.91,
                "priority": priority,
                "code_location": {
                    "absolute_file_path": path,
                    "line_range": {"start": 2, "end": 2},
                },
            }
        ],
        "overall_correctness": "patch is incorrect",
        "overall_explanation": "The patch introduces a token refresh regression.",
        "overall_confidence_score": 0.86,
    }


class SkillDocumentTests(unittest.TestCase):
    def test_skill_uses_opencode_frontmatter(self) -> None:
        text = SKILL_FILE.read_text()
        frontmatter = text.split("---", 2)[1]

        self.assertIn("name: code-review", frontmatter)
        self.assertIn("compatibility: opencode", frontmatter)
        self.assertIn("workflow: github-pr-review", frontmatter)
        self.assertNotIn("allowed-tools:", frontmatter)
        self.assertNotIn("user-invocable:", frontmatter)

    def test_skill_starts_with_resolver_workflow(self) -> None:
        text = SKILL_FILE.read_text()

        self.assertLess(text.index("## Start Here"), text.index("## Workflow"))
        self.assertLess(text.index("resolve_review_target.py"), text.index("## Review Rules"))


class ResolveReviewTargetTests(unittest.TestCase):
    def test_bare_text_is_instructions_not_range(self) -> None:
        def fake_runner(command: list[str], cwd: Path) -> str:
            if command[:3] == ["gh", "pr", "view"]:
                raise RuntimeError("no pr")
            if command[:2] == ["git", "symbolic-ref"]:
                raise RuntimeError("no origin head")
            if command == ["git", "merge-base", "HEAD", "main"]:
                return "abc123\n"
            raise AssertionError(command)

        resolved = resolve_review_target.resolve_review_target(
            ["HEAD~3"],
            cwd=Path("/repo"),
            runner=fake_runner,
        )

        self.assertEqual(resolved["target_type"], "base")
        self.assertEqual(resolved["instructions"], "HEAD~3")
        self.assertEqual(resolved["diff_command"], ["git", "diff", "abc123"])

    def test_range_flag_selects_git_diff_range(self) -> None:
        resolved = resolve_review_target.resolve_review_target(
            ["--range", "HEAD~3..HEAD", "focus", "on", "db"],
            cwd=Path("/repo"),
            runner=lambda command, cwd: "",
        )

        self.assertEqual(resolved["target_type"], "range")
        self.assertEqual(resolved["range"], "HEAD~3..HEAD")
        self.assertEqual(resolved["instructions"], "focus on db")
        self.assertEqual(resolved["diff_command"], ["git", "diff", "HEAD~3..HEAD"])

    def test_post_requires_a_pr(self) -> None:
        def fake_runner(command: list[str], cwd: Path) -> str:
            if command[:3] == ["gh", "pr", "view"]:
                raise RuntimeError("no pr")
            if command[:2] == ["git", "symbolic-ref"]:
                raise RuntimeError("no origin head")
            if command == ["git", "merge-base", "HEAD", "main"]:
                return "abc123\n"
            raise AssertionError(command)

        with self.assertRaises(SystemExit):
            resolve_review_target.resolve_review_target(
                ["--post"],
                cwd=Path("/repo"),
                runner=fake_runner,
            )

    def test_default_detects_current_branch_pr(self) -> None:
        resolved = resolve_review_target.resolve_review_target(
            ["--post", "focus", "security"],
            cwd=Path("/repo"),
            runner=pr_runner,
        )

        self.assertEqual(resolved["target_type"], "pr")
        self.assertEqual(resolved["pr"]["number"], 42)
        self.assertTrue(resolved["post"])
        self.assertEqual(resolved["post_source"], "flag")
        self.assertEqual(resolved["instructions"], "focus security")

    def test_natural_language_post_intent_posts_current_pr(self) -> None:
        resolved = resolve_review_target.resolve_review_target(
            ["post", "a", "review", "on", "the", "pr"],
            cwd=Path("/repo"),
            runner=pr_runner,
        )

        self.assertEqual(resolved["target_type"], "pr")
        self.assertTrue(resolved["post"])
        self.assertEqual(resolved["post_source"], "instructions")

    def test_dry_run_language_overrides_post_intent(self) -> None:
        resolved = resolve_review_target.resolve_review_target(
            ["post", "a", "review", "on", "the", "pr", "but", "dry", "run"],
            cwd=Path("/repo"),
            runner=pr_runner,
        )

        self.assertFalse(resolved["post"])
        self.assertEqual(resolved["post_source"], "dry_run")

    def test_dry_run_flag_overrides_natural_language_post_intent(self) -> None:
        resolved = resolve_review_target.resolve_review_target(
            ["--dry-run", "post", "a", "review", "on", "the", "pr"],
            cwd=Path("/repo"),
            runner=pr_runner,
        )

        self.assertFalse(resolved["post"])
        self.assertEqual(resolved["post_source"], "dry_run")

    def test_ambiguous_pr_review_text_does_not_post(self) -> None:
        resolved = resolve_review_target.resolve_review_target(
            ["review", "the", "pr", "for", "security"],
            cwd=Path("/repo"),
            runner=pr_runner,
        )

        self.assertFalse(resolved["post"])
        self.assertEqual(resolved["post_source"], "default")


class ReviewRenderingTests(unittest.TestCase):
    def test_valid_review_json_renders_markdown(self) -> None:
        output, error = parse_review_output(json.dumps(sample_output()))

        self.assertIsNone(error)
        rendered = render_markdown(output)

        self.assertIn("Review comment:", rendered)
        self.assertIn("### [P1] Preserve the saved token", rendered)
        self.assertIn("**Overall correctness:** `patch is incorrect`", rendered)

    def test_invalid_json_falls_back_to_plain_text(self) -> None:
        output, error = parse_review_output("plain text review")

        self.assertIsNotNone(error)
        self.assertEqual(output["findings"], [])
        self.assertIn("plain text review", render_markdown(output))


class GitHubPostingTests(unittest.TestCase):
    def test_collect_commentable_lines_from_patch(self) -> None:
        diff = """diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 context
-old
+new
+more
"""

        lines = post_github_review.collect_commentable_lines(diff)

        self.assertEqual(lines["src/app.ts"], {1, 2, 3})

    def test_build_review_payload_posts_inline_comment(self) -> None:
        diff = """diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 context
-old
+new
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = sample_output(str(root / "src/app.ts"), priority=1)
            payload = post_github_review.build_review_payload(
                output,
                root=root,
                diff_text=diff,
                head_sha="deadbeef",
            )

        self.assertEqual(payload["event"], "REQUEST_CHANGES")
        self.assertEqual(payload["commit_id"], "deadbeef")
        self.assertEqual(payload["comments"][0]["path"], "src/app.ts")
        self.assertEqual(payload["comments"][0]["line"], 2)
        body = payload["comments"][0]["body"]
        self.assertIn("https://img.shields.io/badge/P1-orange", body)
        self.assertIn("Preserve the saved token", body)
        self.assertNotIn("[P1]", body)

    def test_unpostable_finding_moves_to_review_body(self) -> None:
        diff = """diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1 @@
-old
+new
"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = sample_output(str(root / "src/app.ts"), priority=2)
            payload = post_github_review.build_review_payload(
                output,
                root=root,
                diff_text=diff,
                head_sha="deadbeef",
            )

        self.assertEqual(payload["event"], "COMMENT")
        self.assertEqual(payload["comments"], [])
        self.assertIn("Unposted findings:", payload["body"])

    def test_zero_findings_can_approve_when_explicit(self) -> None:
        output = {
            "findings": [],
            "overall_correctness": "patch is correct",
            "overall_explanation": "No issues found.",
            "overall_confidence_score": 0.8,
        }

        self.assertEqual(
            post_github_review.review_event(output, post_approve=True),
            "APPROVE",
        )


def pr_runner(command: list[str], cwd: Path) -> str:
    if command[:3] == ["gh", "pr", "view"]:
        return json.dumps(
            {
                "number": 42,
                "baseRefName": "main",
                "headRefName": "feature",
                "headRefOid": "abc",
                "title": "Feature",
                "url": "https://github.com/acme/widgets/pull/42",
            }
        )
    raise AssertionError(command)
