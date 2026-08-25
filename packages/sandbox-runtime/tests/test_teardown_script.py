"""Tests for RepositoryHooks.run_teardown()."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_repository_boot


def _make_repository_boot(tmp_path):
    sup = make_repository_boot(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
        workspace_path=tmp_path,
    )
    sup.repo_path = tmp_path / "app"
    sup.repositories = sup._parse_repositories()
    return sup


def _create_teardown_script(repo_path):
    repo_path.mkdir(parents=True, exist_ok=True)
    hook_dir = repo_path / ".openinspect"
    hook_dir.mkdir(parents=True, exist_ok=True)
    script = hook_dir / "teardown.sh"
    script.write_text("#!/bin/bash\necho teardown\n")
    return script


def _fake_process(returncode=0, stdout=b""):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=(stdout, None))
    return process


async def test_skip_when_no_teardown_script(tmp_path):
    sup = _make_repository_boot(tmp_path)
    sup.repo_path.mkdir(parents=True)

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
        result = await sup.hooks.run_teardown(sup.repositories[0], BootMode.FRESH)

    assert result is True
    mock_exec.assert_not_called()


async def test_teardown_runs_with_repository_context(tmp_path):
    sup = _make_repository_boot(tmp_path)
    script = _create_teardown_script(sup.repo_path)
    fake_process = _fake_process(stdout=b"done\n")

    with patch(
        "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_process
    ) as mock_exec:
        result = await sup.hooks.run_teardown(sup.repositories[0], BootMode.SNAPSHOT_RESTORE)

    assert result is True
    mock_exec.assert_awaited_once()
    call = mock_exec.call_args
    assert call.args == ("bash", str(script))
    assert call.kwargs["cwd"] == sup.repo_path
    assert call.kwargs["env"]["OPENINSPECT_BOOT_MODE"] == "snapshot_restore"
    assert call.kwargs["start_new_session"] is True


async def test_teardown_failure_is_reported(tmp_path):
    sup = _make_repository_boot(tmp_path)
    _create_teardown_script(sup.repo_path)
    fake_process = _fake_process(returncode=1, stdout=b"cleanup failed\n")

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_process):
        result = await sup.hooks.run_teardown(sup.repositories[0], BootMode.FRESH)

    assert result is False


async def test_teardown_uses_60_second_default_timeout(tmp_path, monkeypatch):
    sup = _make_repository_boot(tmp_path)
    _create_teardown_script(sup.repo_path)
    fake_process = _fake_process(stdout=b"done\n")
    captured_timeout = None
    original_wait_for = asyncio.wait_for

    async def capture_timeout(coro, *, timeout=None):
        nonlocal captured_timeout
        captured_timeout = timeout
        return await original_wait_for(coro, timeout=timeout)

    monkeypatch.delenv("TEARDOWN_TIMEOUT_SECONDS", raising=False)
    with (
        patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_process),
        patch("asyncio.wait_for", side_effect=capture_timeout),
    ):
        await sup.hooks.run_teardown(sup.repositories[0], BootMode.FRESH)

    assert captured_timeout == 60
