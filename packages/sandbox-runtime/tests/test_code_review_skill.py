from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
from resolve_review_target import run_text  # noqa: E402
from review_utils import ReviewValidationError, parse_review_output, render_markdown  # noqa: E402


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
    def test_skill_frontmatter_is_harness_neutral(self) -> None:
        text = SKILL_FILE.read_text()
        frontmatter = text.split("---", 2)[1]

        self.assertIn("name: code-review", frontmatter)
        self.assertNotIn("compatibility:", frontmatter)
        self.assertIn("workflow: github-pr-review", frontmatter)
        self.assertNotIn("allowed-tools:", frontmatter)
        self.assertNotIn("user-invocable:", frontmatter)


class ResolveReviewTargetTests(unittest.TestCase):
    def test_bare_text_is_instructions_not_range(self) -> None:
        def fake_runner(command: list[str], cwd: Path) -> str:
            if command[:3] == ["gh", "pr", "view"]:
                raise subprocess.CalledProcessError(1, command)
            if command[:2] == ["git", "symbolic-ref"]:
                raise subprocess.CalledProcessError(1, command)
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
        self.assertEqual(resolved["diff_command"], ["git", "diff", "abc123", "--"])

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
                raise subprocess.CalledProcessError(1, command)
            if command[:2] == ["git", "symbolic-ref"]:
                raise subprocess.CalledProcessError(1, command)
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

        self.assertIn("The patch introduces a token refresh regression.", rendered)
        self.assertIn("### [P1] Preserve the saved token", rendered)
        self.assertIn("[app.ts:2](</repo/src/app.ts:2>)", rendered)

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
        self.assertEqual(body, "[P1] Preserve the saved token\n\n" + output["findings"][0]["body"])

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


def review_output(root: Path, *, findings: bool = True) -> dict:
    return {
        "findings": (
            [
                {
                    "title": '[P1] Preserve the "organization" boundary',
                    "body": "En annen organisasjons rådata kan endres. See [AGENTS.md](AGENTS.md:12).",
                    "confidence_score": 0.95,
                    "priority": 1,
                    "code_location": {
                        "absolute_file_path": str(root / 'a "file".py'),
                        "line_range": {"start": 1, "end": 1},
                    },
                }
            ]
            if findings
            else []
        ),
        "overall_correctness": "patch is incorrect" if findings else "patch is correct",
        "overall_explanation": (
            "The update loses organization scoping." if findings else "No actionable issues found."
        ),
        "overall_confidence_score": 0.95,
    }


class ReviewBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.git("init", "-q", "-b", "main")

    def git(self, *args: str) -> str:
        return subprocess.check_output(
            ["git", *args],
            cwd=self.root,
            env=self.environment,
            text=True,
            stderr=subprocess.DEVNULL,
        ).rstrip("\n")

    def runner(self, command: list[str], cwd: Path) -> str:
        self.assertEqual(command[0], "git", "local scopes must not reach GitHub")
        self.assertEqual(cwd, self.root)
        return self.git(*command[1:])

    def commit(self):
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Review Test",
            "-c",
            "user.email=review@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        )

    def test_uncommitted_includes_staged_unstaged_and_untracked(self):
        tracked = self.root / "tracked.py"
        tracked.write_text("original\n")
        self.commit()
        tracked.write_text("staged\n")
        self.git("add", "tracked.py")
        tracked.write_text("unstaged\n")
        new_name = " fresh file\n.py"
        (self.root / new_name).write_text("new\n")
        target = resolve_review_target.resolve_review_target(
            ["--uncommitted"], cwd=self.root, runner=self.runner
        )
        diffs = [self.runner(command, self.root) for command in target["diff_commands"]]
        self.assertIn("+staged", diffs[0])
        self.assertIn("+unstaged", diffs[1])
        self.assertEqual(run_text(target["untracked_command"], self.root), new_name + "\0")
        self.assertFalse(target["post"])

    def test_unborn_repository_still_reviews_new_files(self):
        (self.root / "new.py").write_text("new\n")
        target = resolve_review_target.resolve_review_target(
            ["--uncommitted"], cwd=self.root, runner=self.runner
        )
        self.assertEqual([self.runner(c, self.root) for c in target["diff_commands"]], ["", ""])
        self.assertEqual(self.runner(target["untracked_command"], self.root), "new.py\0")

    def test_commit_scope_excludes_working_changes(self):
        tracked = self.root / "tracked.py"
        tracked.write_text("original\n")
        self.commit()
        root_target = resolve_review_target.resolve_review_target(
            ["--commit", "HEAD"], cwd=self.root, runner=self.runner
        )
        self.assertIn("+original", self.runner(root_target["diff_command"], self.root))
        tracked.write_text("committed\n")
        self.commit()
        tracked.write_text("working\n")
        target = resolve_review_target.resolve_review_target(
            ["--commit", "HEAD"], cwd=self.root, runner=self.runner
        )
        diff = self.runner(target["diff_command"], self.root)
        self.assertIn("+committed", diff)
        self.assertNotIn("+working", diff)
        self.assertNotIn("untracked_command", target)

    def test_merge_commit_scope_uses_first_parent(self):
        (self.root / "base.py").write_text("base\n")
        self.commit()
        self.git("checkout", "-qb", "feature")
        (self.root / "feature.py").write_text("merged\n")
        self.commit()
        self.git("checkout", "-q", "main")
        (self.root / "main.py").write_text("first parent\n")
        self.commit()
        self.git(
            "-c",
            "user.name=Review Test",
            "-c",
            "user.email=review@example.test",
            "-c",
            "commit.gpgsign=false",
            "merge",
            "--no-ff",
            "-qm",
            "fixture merge",
            "feature",
        )
        (self.root / "feature.py").write_text("working\n")
        target = resolve_review_target.resolve_review_target(
            ["--commit", "HEAD"], cwd=self.root, runner=self.runner
        )
        diff = self.runner(target["diff_command"], self.root)
        self.assertIn("+merged", diff)
        self.assertEqual(diff, self.git("diff", "HEAD^", "HEAD", "--"))

    def test_base_scope_includes_branch_working_and_untracked_changes(self):
        tracked = self.root / "tracked.py"
        tracked.write_text("original\n")
        self.commit()
        self.git("checkout", "-qb", "feature")
        tracked.write_text("branch\n")
        self.commit()
        tracked.write_text("working\n")
        (self.root / "new.py").write_text("new\n")
        target = resolve_review_target.resolve_review_target(
            ["--base", "main"], cwd=self.root, runner=self.runner
        )
        self.assertIn("+working", self.runner(target["diff_command"], self.root))
        self.assertEqual(self.runner(target["untracked_command"], self.root), "new.py\0")
        with self.assertRaises(SystemExit):
            resolve_review_target.resolve_review_target(
                ["--base", "missing"], cwd=self.root, runner=self.runner
            )

    def test_negation_and_dry_run_override_posting(self):
        def github_runner(command: list[str], cwd: Path) -> str:
            return json.dumps({"number": 123, "headRefOid": "reviewed"})

        for args in [
            ["--pr", "123", "--post", "do not post"],
            ["--pr", "123", "--post", "--dry-run"],
        ]:
            with self.subTest(args=args):
                target = resolve_review_target.resolve_review_target(
                    args, cwd=self.root, runner=github_runner
                )
                self.assertFalse(target["post"])
                self.assertEqual(target["post_source"], "dry_run")

    def test_inline_comments_preserve_quoted_values_and_rule_citations(self):
        output = review_output(self.root)
        markdown = render_markdown(output, inline_comments=True)
        directive = next(
            line for line in markdown.splitlines() if line.startswith("::code-comment")
        )
        attributes = dict(re.findall(r'(\w+)=("(?:\\.|[^"\\])*"|\d+)', directive))
        values = {key: json.loads(value) for key, value in attributes.items()}
        self.assertEqual(values["body"], output["findings"][0]["body"])
        self.assertEqual(
            values["file"], output["findings"][0]["code_location"]["absolute_file_path"]
        )
        self.assertEqual(values["priority"], 1)
        self.assertNotIn("::code-comment", render_markdown(output))
        self.assertIn("rådata", directive)
        self.assertEqual(
            render_markdown(review_output(self.root, findings=False)),
            "No actionable issues found.\n",
        )
        result = subprocess.run(
            ["python3", str(SCRIPTS_DIR / "render_review.py"), "--inline-comments"],
            input=json.dumps(output),
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(directive, result.stdout)

    def test_invalid_output_never_renders_as_an_empty_review(self):
        result = subprocess.run(
            ["python3", str(SCRIPTS_DIR / "render_review.py")],
            input="not review JSON",
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        output = review_output(self.root)
        output["findings"][0]["priority"] = 3
        with self.assertRaises(ReviewValidationError):
            parse_review_output(json.dumps(output), allow_fallback=False)

    def test_posting_preserves_rule_citations_and_does_not_approve_incomplete_review(self):
        output = review_output(self.root)
        diff = (
            'diff --git a/a "file".py b/a "file".py\n'
            '--- a/a "file".py\n+++ b/a "file".py\n@@ -1 +1 @@\n-old\n+new\n'
        )
        payload = post_github_review.build_review_payload(
            output, root=self.root, diff_text=diff, head_sha="reviewed"
        )
        self.assertEqual(payload["commit_id"], "reviewed")
        self.assertEqual(payload["event"], "REQUEST_CHANGES")
        self.assertIn("[AGENTS.md](AGENTS.md:12)", payload["comments"][0]["body"])
        output = review_output(self.root, findings=False)
        self.assertEqual(post_github_review.review_event(output, post_approve=True), "APPROVE")
        output["overall_correctness"] = "patch is incorrect"
        self.assertEqual(post_github_review.review_event(output, post_approve=True), "COMMENT")

    def test_changed_pr_head_is_rejected_before_posting(self):
        review_file = self.root / "review.json"
        review_file.write_text(json.dumps(review_output(self.root)))
        args = ["--pr", "123", "--head-sha", "reviewed", "--review-json", str(review_file)]
        for heads in [["changed"], ["reviewed", "changed"]]:
            with self.subTest(heads=heads), contextlib.ExitStack() as stack:
                stack.enter_context(
                    patch.object(
                        post_github_review,
                        "gh_json",
                        side_effect=[{"headRefOid": h} for h in heads],
                    )
                )
                stack.enter_context(
                    patch.object(
                        post_github_review,
                        "repo_root",
                        return_value=self.root,
                    )
                )
                stack.enter_context(patch.object(post_github_review, "run", return_value=""))
                submit = stack.enter_context(patch.object(post_github_review, "submit_review"))
                stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                with self.assertRaises(SystemExit):
                    post_github_review.main(args)
                submit.assert_not_called()
