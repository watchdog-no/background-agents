"""The bridge turns the Claude handoff into SDK options."""

from __future__ import annotations

from unittest.mock import MagicMock, patch


class TestBridgeDirectories:
    """The bridge turns the Claude handoff into SDK options."""

    @staticmethod
    def _build(tmp_path, handoff):
        from sandbox_runtime.harness import BridgeIdentity, build_agent_harness
        from sandbox_runtime.harness.base import HarnessId, PromptLimits

        with (
            patch("sandbox_runtime.harness.ClaudeHarnessHandoff.read", return_value=handoff),
            patch("sandbox_runtime.harness.claude.ClaudeHarness") as claude,
        ):
            build_agent_harness(
                HarnessId.CLAUDE,
                identity=BridgeIdentity(
                    "sandbox", "session", "https://control.test", "token", tmp_path / "r.json"
                ),
                attachment_processor=MagicMock(),
                log=MagicMock(),
                limits=PromptLimits(60, 120, 10),
                opencode_port=4096,
            )
        return claude.call_args.kwargs["config"]

    def test_multi_repo_reads_workspace_notes_once(self, tmp_path):
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        workspace = tmp_path / "workspace"
        (workspace / "api").mkdir(parents=True)
        (workspace / "web").mkdir()
        (workspace / "api" / "CLAUDE.md").write_text("# api rules")
        (workspace / "AGENTS.md").write_text("# Workspace notes")
        handoff = ClaudeHarnessHandoff(
            workspace / "api",
            tmp_path / "config",
            True,
            additional_dirs=(workspace / "web",),
            workspace_dir=workspace,
        )

        config = self._build(tmp_path, handoff)

        assert config.workdir == workspace / "api"
        assert config.add_dirs == (workspace / "web",)
        # The primary's CLAUDE.md must not suppress the workspace notes.
        assert config.system_prompt_append == "Workspace guidance (AGENTS.md):\n\n# Workspace notes"
        assert config.claude_md_excludes == (str(workspace / "AGENTS.md"),)

    def test_multi_repo_without_notes_excludes_nothing(self, tmp_path):
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        workspace = tmp_path / "workspace"
        (workspace / "api").mkdir(parents=True)
        handoff = ClaudeHarnessHandoff(
            workspace / "api", tmp_path / "config", True, workspace_dir=workspace
        )

        config = self._build(tmp_path, handoff)

        assert config.system_prompt_append is None
        assert config.claude_md_excludes == ()

    def test_missing_primary_still_reads_workspace_notes_once(self, tmp_path):
        """Falling back to /workspace as the start directory is the layout where
        Claude Code reads the notes natively, so the exclude matters most here."""
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        workspace = tmp_path / "workspace"
        workspace.mkdir()
        (workspace / "AGENTS.md").write_text("# Workspace notes")
        handoff = ClaudeHarnessHandoff(
            workspace, tmp_path / "config", True, workspace_dir=workspace
        )

        config = self._build(tmp_path, handoff)

        assert config.workdir == workspace
        assert config.system_prompt_append == "Workspace guidance (AGENTS.md):\n\n# Workspace notes"
        assert config.claude_md_excludes == (str(workspace / "AGENTS.md"),)

    def test_stray_workspace_claude_md_does_not_suppress_the_notes(self, tmp_path):
        """A CLAUDE.md left in /workspace stops Claude Code reading the notes
        natively, so the system prompt is their only route."""
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        workspace = tmp_path / "workspace"
        (workspace / "api").mkdir(parents=True)
        (workspace / "AGENTS.md").write_text("# Workspace notes")
        (workspace / "CLAUDE.md").write_text("Left behind by an earlier turn")
        handoff = ClaudeHarnessHandoff(
            workspace / "api", tmp_path / "config", True, workspace_dir=workspace
        )

        config = self._build(tmp_path, handoff)

        assert config.system_prompt_append == "Workspace guidance (AGENTS.md):\n\n# Workspace notes"
        assert config.claude_md_excludes == (str(workspace / "AGENTS.md"),)

    def test_primary_agents_md_reaches_the_prompt_once(self, tmp_path):
        """Any CLAUDE.md in or above the primary stops Claude Code reading its
        AGENTS.md natively, so it takes the system-prompt route single-repo uses."""
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        workspace = tmp_path / "workspace"
        (workspace / "api" / ".claude").mkdir(parents=True)
        (workspace / "AGENTS.md").write_text("# Workspace notes")
        (workspace / "api" / "AGENTS.md").write_text("# Api notes")
        (workspace / "api" / ".claude" / "CLAUDE.md").write_text("# Api rules")
        handoff = ClaudeHarnessHandoff(
            workspace / "api", tmp_path / "config", True, workspace_dir=workspace
        )

        config = self._build(tmp_path, handoff)

        assert config.system_prompt_append == (
            "Workspace guidance (AGENTS.md):\n\n# Workspace notes\n\n"
            f"Primary repository guidance ({workspace / 'api' / 'AGENTS.md'}):\n\n# Api notes"
        )
        assert config.claude_md_excludes == (
            str(workspace / "AGENTS.md"),
            str(workspace / "api" / "AGENTS.md"),
        )

    def test_primary_root_claude_md_keeps_its_agents_md_native(self, tmp_path):
        """A root CLAUDE.md is the primary's own entry point, as in a single-repo session."""
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        workspace = tmp_path / "workspace"
        (workspace / "api").mkdir(parents=True)
        (workspace / "AGENTS.md").write_text("# Workspace notes")
        (workspace / "api" / "AGENTS.md").write_text("# Api notes")
        (workspace / "api" / "CLAUDE.md").write_text("@AGENTS.md")
        handoff = ClaudeHarnessHandoff(
            workspace / "api", tmp_path / "config", True, workspace_dir=workspace
        )

        config = self._build(tmp_path, handoff)

        assert config.system_prompt_append == "Workspace guidance (AGENTS.md):\n\n# Workspace notes"
        assert config.claude_md_excludes == (str(workspace / "AGENTS.md"),)

    def test_symlinked_workspace_excludes_both_spellings(self, tmp_path):
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        real = tmp_path / "home" / "workspace"
        (real / "api").mkdir(parents=True)
        (real / "AGENTS.md").write_text("# Workspace notes")
        link = tmp_path / "workspace"
        link.symlink_to(real)
        handoff = ClaudeHarnessHandoff(link / "api", tmp_path / "config", True, workspace_dir=link)

        config = self._build(tmp_path, handoff)

        assert config.claude_md_excludes == (
            str(link / "AGENTS.md"),
            str((real / "AGENTS.md").resolve()),
        )

    def test_single_repo_bridge_config_is_unchanged(self, tmp_path):
        from sandbox_runtime.claude_stager import ClaudeHarnessHandoff

        repo = tmp_path / "api"
        repo.mkdir()
        (repo / "AGENTS.md").write_text("# api rules")

        config = self._build(tmp_path, ClaudeHarnessHandoff(repo, tmp_path / "config", True))

        assert config.workdir == repo
        assert config.add_dirs == ()
        assert config.claude_md_excludes == ()
        assert config.system_prompt_append == "Workspace guidance (AGENTS.md):\n\n# api rules"
