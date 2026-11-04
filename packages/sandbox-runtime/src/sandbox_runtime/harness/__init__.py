"""Agent harness seam: one registry, two halves (see ``base.py``)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..claude_stager import ClaudeHarnessHandoff
from ..codex_stager import CodexHarnessHandoff
from ..credentials.openai_access_token_client import OpenAIAccessTokenClient
from ..credentials.provider_credential_client import RuntimeCredentialClient
from ..managed_mcp import ManagedMcpHarness, personal_names
from ..memories import append_memory
from ..model_prices import ModelPriceCatalog, default_catalog_path
from .base import (
    DEFAULT_HARNESS_ID,
    DETERMINISTIC_FAILURE_EXIT_CODE,
    AgentHarness,
    BridgeEvent,
    EventSink,
    HarnessId,
    HarnessProcessOwner,
    HarnessPrompt,
    HarnessStartError,
    ManagedMcpNativeHarness,
    PromptLimits,
    TurnOutcome,
    parse_harness_id,
)
from .claude_env import OAUTH_MANAGED_ENV_VAR
from .codex import CodexHarness, CodexHarnessConfig
from .opencode import OpencodeHarness
from .opencode_client import OpenCodeClient
from .tools import ToolServerConfig

if TYPE_CHECKING:
    from pathlib import Path

    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger


@dataclass(frozen=True)
class BridgeIdentity:
    """What a harness needs to call the control plane on the session's behalf."""

    sandbox_id: str
    session_id: str
    control_plane_url: str
    auth_token: str
    repo_manifest_path: Path


def build_agent_harness(
    harness_id: HarnessId,
    *,
    identity: BridgeIdentity,
    attachment_processor: AttachmentProcessor,
    log: StructuredLogger,
    limits: PromptLimits,
    opencode_port: int,
) -> AgentHarness:
    """The bridge-half registry: one ``match`` is the whole thing."""
    servers = _mcp_servers_from(_session_config_from_env())

    def managed(harness: ManagedMcpNativeHarness) -> AgentHarness:
        if not personal_names(servers):
            return harness
        return ManagedMcpHarness(
            harness,
            servers=servers,
            control_plane_url=identity.control_plane_url,
            session_id=identity.session_id,
            auth_token=identity.auth_token,
        )

    match harness_id:
        case HarnessId.OPENCODE:
            return managed(
                OpencodeHarness(
                    client=OpenCodeClient(base_url=f"http://localhost:{opencode_port}", log=log),
                    attachment_processor=attachment_processor,
                    log=log,
                    limits=limits,
                    managed_mcp_names=personal_names(servers),
                )
            )
        case HarnessId.CLAUDE:
            from .claude import ClaudeHarness, ClaudeHarnessConfig

            handoff = ClaudeHarnessHandoff.read()
            session_config = _session_config_from_env()
            oauth_managed = bool(os.environ.get(OAUTH_MANAGED_ENV_VAR))
            guidance, claude_md_excludes = _claude_guidance(handoff.workdir, handoff.workspace_dir)
            config = ClaudeHarnessConfig(
                workdir=handoff.workdir,
                add_dirs=handoff.additional_dirs,
                claude_md_excludes=claude_md_excludes,
                config_dir=handoff.config_dir,
                # From the bridge's own SESSION_CONFIG: MCP entries can carry
                # credentials, and the handoff file never does.
                mcp_servers=_mcp_servers_from(session_config),
                default_model=str(session_config.get("model") or "claude-sonnet-4-6"),
                oauth_managed=oauth_managed,
                system_prompt_append=append_memory(guidance, handoff.config_dir),
                tools=ToolServerConfig(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    auth_token=identity.auth_token,
                    repo_manifest_path=identity.repo_manifest_path,
                    has_repository=handoff.has_repository,
                    slack_notify_enabled=os.environ.get("AGENT_SLACK_NOTIFY_ENABLED", "").lower()
                    == "true",
                ),
            )
            credential_client = (
                RuntimeCredentialClient(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    sandbox_id=identity.sandbox_id,
                    auth_token=identity.auth_token,
                    log=log,
                )
                if oauth_managed and identity.control_plane_url
                else None
            )
            return managed(
                ClaudeHarness(
                    config=config,
                    log=log,
                    limits=limits,
                    credential_client=credential_client,
                )
            )
        case HarnessId.CODEX:
            codex_handoff = CodexHarnessHandoff.read()
            session_config = _session_config_from_env()
            oauth_managed = os.environ.get("OPENAI_OAUTH_MANAGED") in {"1", "true"}
            codex_config = CodexHarnessConfig(
                workdir=codex_handoff.workdir,
                state_dir=codex_handoff.config_dir,
                default_model=str(session_config.get("model") or "gpt-6.1-sol"),
                oauth_managed=oauth_managed,
                mcp_servers=_mcp_servers_from(session_config),
                restored=os.environ.get("RESTORED_FROM_SNAPSHOT") == "true",
                tools=ToolServerConfig(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    auth_token=identity.auth_token,
                    repo_manifest_path=identity.repo_manifest_path,
                    has_repository=codex_handoff.has_repository,
                    slack_notify_enabled=os.environ.get("AGENT_SLACK_NOTIFY_ENABLED", "").lower()
                    == "true",
                ),
            )
            token_client = (
                OpenAIAccessTokenClient(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    auth_token=identity.auth_token,
                    log=log,
                )
                if oauth_managed
                else None
            )
            return CodexHarness(
                config=codex_config,
                log=log,
                limits=limits,
                credential_client=token_client,
                prices=ModelPriceCatalog(default_catalog_path(os.environ), log),
            )
    raise ValueError(f"Unsupported harness: {harness_id}")


def _session_config_from_env() -> dict[str, object]:
    import json
    import os

    try:
        parsed = json.loads(os.environ.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _mcp_servers_from(session_config: dict[str, object]) -> tuple[dict[str, object], ...]:
    servers = session_config.get("mcp_servers")
    if not isinstance(servers, list):
        return ()
    return tuple(server for server in servers if isinstance(server, dict))


def _exclude_patterns(path: Path) -> tuple[str, ...]:
    """``claudeMdExcludes`` entries for ``path`` as given and as resolved.

    Claude Code matches against the path it reads, which follows the child's
    resolved cwd; a provider that symlinks ``/workspace`` would otherwise slip
    past. The paths are runtime-owned, so they carry no glob metacharacters.
    """
    patterns = [str(path)]
    try:
        resolved = str(path.resolve())
    except OSError:
        resolved = patterns[0]
    if resolved not in patterns:
        patterns.append(resolved)
    return tuple(patterns)


def _claude_guidance(
    workdir: Path, workspace_dir: Path | None
) -> tuple[str | None, tuple[str, ...]]:
    """System-prompt guidance for Claude, and the files it must not also load natively."""
    if workspace_dir is None:
        return _repository_guidance(workdir), ()
    # The generated workspace notes, and the primary's own AGENTS.md as a
    # single-repo session would get it: any CLAUDE.md in the primary or above
    # it stops Claude Code reading that file natively. Both arrive through the
    # system prompt and are excluded from native loading, so each appears once.
    sections = [(workspace_dir, _repository_guidance(workspace_dir, multi_repo=True))]
    if workdir != workspace_dir:
        sections.append(
            (
                workdir,
                _repository_guidance(
                    workdir, heading=f"Primary repository guidance ({workdir / 'AGENTS.md'})"
                ),
            )
        )
    found = [(directory, text) for directory, text in sections if text]
    excludes = tuple(
        pattern for directory, _ in found for pattern in _exclude_patterns(directory / "AGENTS.md")
    )
    return "\n\n".join(text for _, text in found) or None, excludes


def _repository_guidance(
    directory: Path, *, multi_repo: bool = False, heading: str = "Workspace guidance (AGENTS.md)"
) -> str | None:
    """Surface ``directory``'s AGENTS.md through the system prompt.

    ``directory`` is the start directory, or in a multi-repo session the
    workspace or the primary checkout. Claude reads CLAUDE.md natively; multi-repo workspaces only carry
    the AGENTS.md the supervisor writes, and nothing is written into repositories.
    A stray workspace CLAUDE.md (one restored from a snapshot) would stop Claude
    Code reading the generated notes natively, so it never suppresses them.
    """
    notes = directory / "AGENTS.md"
    if not notes.is_file() or (not multi_repo and (directory / "CLAUDE.md").is_file()):
        return None
    try:
        text = notes.read_text().strip()
    except OSError:
        return None
    if not text:
        return None
    return f"{heading}:\n\n{text}"


__all__ = [
    "DEFAULT_HARNESS_ID",
    "DETERMINISTIC_FAILURE_EXIT_CODE",
    "AgentHarness",
    "BridgeEvent",
    "BridgeIdentity",
    "EventSink",
    "HarnessId",
    "HarnessProcessOwner",
    "HarnessPrompt",
    "HarnessStartError",
    "PromptLimits",
    "TurnOutcome",
    "build_agent_harness",
    "parse_harness_id",
]
