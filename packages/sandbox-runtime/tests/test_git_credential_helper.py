"""Tests for the git credential helper."""

from __future__ import annotations

import io
import json
import threading
import time
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import httpx
import pytest

import sandbox_runtime.credentials.git_credential_helper as helper

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate the helper's on-disk cache to a per-test temp directory."""
    monkeypatch.setenv("OI_SCM_CRED_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(helper, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(helper, "CACHE_FILE", tmp_path / "scm-creds.json")
    monkeypatch.setattr(helper, "LOCK_FILE", tmp_path / "scm-creds.lock")
    return tmp_path


@pytest.fixture
def env_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://cp.example.com")
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "sandbox-token-xyz")
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"sessionId": "sess-123"}))


def _run(stdin_text: str, action: str = "get") -> tuple[int, str, str]:
    """Drive helper.main() with captured stdio."""
    stdin = io.StringIO(stdin_text)
    stdout = io.StringIO()
    stderr = io.StringIO()
    with patch.object(helper.sys, "stdin", stdin), patch.object(
        helper.sys, "stdout", stdout
    ), patch.object(helper.sys, "stderr", stderr):
        code = helper.main([action])
    return code, stdout.getvalue(), stderr.getvalue()


def _mock_response(payload: dict[str, Any], status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def _patch_httpx(transport: httpx.MockTransport, call_count: list[int]) -> Any:
    """Patch httpx.Client to use a mock transport and count requests.

    Saves the real ``httpx.Client`` so the factory can still construct one
    after the module attribute has been replaced.
    """
    real_client_cls = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        def counting(request: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            return transport.handle_request(request)

        kwargs.pop("transport", None)
        return real_client_cls(*args, transport=httpx.MockTransport(counting), **kwargs)

    return patch.object(helper.httpx, "Client", factory)


def test_get_returns_credentials_on_success(
    cache_dir: Path, env_set: None
) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_abc",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\n\n")

    assert code == 0
    assert "username=x-access-token" in out
    assert "password=ghs_abc" in out
    assert "protocol=https" in out  # echoed back
    assert "host=github.com" in out
    assert out.endswith("\n\n")  # blank line terminates
    assert calls[0] == 1


def test_uses_cache_within_buffer(cache_dir: Path, env_set: None) -> None:
    """A cached entry well within its TTL should be returned without an HTTP call."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_cached",
                "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response({"username": "fresh", "password": "fresh"})
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\n\n")

    assert code == 0
    assert "password=ghs_cached" in out
    assert calls[0] == 0


def test_refreshes_when_cache_within_expiry_buffer(
    cache_dir: Path, env_set: None
) -> None:
    """A near-expiry cache entry should trigger a refresh."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_stale",
                "expires_at_epoch_ms": int((time.time() + 60) * 1000),
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_new",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\n\n")

    assert code == 0
    assert "password=ghs_new" in out
    assert calls[0] == 1

    persisted = json.loads(helper.CACHE_FILE.read_text())
    assert persisted["password"] == "ghs_new"


def test_failure_does_not_fall_back_to_stale_cache(
    cache_dir: Path, env_set: None
) -> None:
    """If the endpoint fails, we must NOT return stale cached credentials."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_stale",
                "expires_at_epoch_ms": int((time.time() - 60) * 1000),  # expired
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response({"error": "unauthorized"}, status=401)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run("protocol=https\nhost=github.com\n\n")

    assert code != 0
    assert "password=" not in out
    assert "401" in err


def test_missing_env_exits_nonzero(cache_dir: Path) -> None:
    code, out, err = _run("protocol=https\nhost=github.com\n\n")
    assert code != 0
    assert "Missing required environment" in err
    assert out == ""


def test_falls_back_to_env_var_token_in_image_build_mode(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Image-build sandboxes have no control plane — VCS_CLONE_TOKEN is used."""
    # Deliberately omit CONTROL_PLANE_URL / SANDBOX_AUTH_TOKEN / SESSION_CONFIG.
    monkeypatch.setenv("VCS_CLONE_TOKEN", "ghs_build_token")
    monkeypatch.setenv("VCS_CLONE_USERNAME", "x-access-token")

    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\n\n")

    assert code == 0
    assert "username=x-access-token" in out
    assert "password=ghs_build_token" in out
    assert calls[0] == 0  # No control-plane call attempted.


def test_store_and_erase_are_noops(
    cache_dir: Path, env_set: None
) -> None:
    """git may invoke `store` or `erase`; we should ignore them and exit 0."""
    transport = _mock_response({"username": "u", "password": "p"})
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(
            "protocol=https\nhost=github.com\nusername=u\npassword=p\n\n",
            action="store",
        )

    assert code == 0
    assert out == ""
    assert calls[0] == 0


def test_concurrent_invocations_share_one_refresh(
    cache_dir: Path, env_set: None
) -> None:
    """Two helpers racing on first boot should result in a single HTTP call."""
    payload = {
        "username": "x-access-token",
        "password": "ghs_locked",
        "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
        "scm_provider": "github",
    }

    call_count = 0
    call_lock = threading.Lock()

    def slow_handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        with call_lock:
            call_count += 1
        time.sleep(0.1)
        return httpx.Response(200, json=payload)

    real_client_cls = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return real_client_cls(*args, transport=httpx.MockTransport(slow_handler), **kwargs)

    results: list[int] = []

    def run_one() -> None:
        stdin = io.StringIO("protocol=https\nhost=github.com\n\n")
        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch.object(helper.sys, "stdin", stdin), patch.object(
            helper.sys, "stdout", stdout
        ), patch.object(helper.sys, "stderr", stderr):
            results.append(helper.main(["get"]))

    with patch.object(helper.httpx, "Client", factory):
        t1 = threading.Thread(target=run_one)
        t2 = threading.Thread(target=run_one)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    assert results == [0, 0]
    assert call_count == 1
    # Cache contains the locked password.
    assert json.loads(helper.CACHE_FILE.read_text())["password"] == "ghs_locked"


def test_cache_file_is_mode_0600(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_secret",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        _run("protocol=https\nhost=github.com\n\n")

    mode = helper.CACHE_FILE.stat().st_mode & 0o777
    assert mode == 0o600
