#!/usr/bin/env python3
"""Run a local OpenCode + AgentBridge smoke prompt against a real repository.

This is a developer harness for debugging sandbox-runtime/OpenCode behavior without
deploying Modal or Cloudflare. It intentionally drives the same bridge path that a
production sandbox uses after startup:

1. prepare a clean repository checkout
2. install bundled .opencode skills/tools into that checkout
3. start `opencode serve`
4. send one prompt through AgentBridge's OpenCode SSE path
5. record bridge events and fail fast on repeated skill-tool loops
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

import sandbox_runtime
from sandbox_runtime.bridge import FALLBACK_GIT_USER, AgentBridge
from sandbox_runtime.entrypoint import AGENT_TOOLS_GATED_ON_ENV

DEFAULT_REPO_OWNER = "watchdog-no"
DEFAULT_REPO_NAME = "watchdog-monorepo"
DEFAULT_PROMPT = "Please use the /code-review skill to review PR 658 in watchdog-monorepo."
DEFAULT_MODEL = "openai/gpt-5.5"
DEFAULT_REASONING_EFFORT = "xhigh"
DEFAULT_OPENCODE_VERSION = "1.15.10"
DEFAULT_WORKDIR = Path(tempfile.gettempdir()) / "openinspect-local-smoke"


@dataclass(frozen=True)
class SmokePaths:
    workdir: Path
    repo_dir: Path
    event_log: Path
    opencode_log: Path
    opencode_runner_dir: Path
    home_dir: Path


@dataclass
class SmokeCounters:
    skill_call_ids: set[str]
    non_skill_tool_call_ids: set[str]
    events_seen: int = 0
    tokens_seen: int = 0
    step_finish_seen: int = 0
    errors_seen: int = 0
    loop_detected: bool = False
    completed: bool = False


def eprint(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: int | None = None,
) -> None:
    eprint(f"$ {' '.join(command)}")
    subprocess.run(
        command,
        cwd=cwd,
        env=env,
        timeout=timeout_seconds,
        check=True,
    )


def default_repo_source() -> str:
    env_path = os.environ.get("WATCHDOG_MONOREPO_PATH")
    if env_path:
        return env_path

    local_path = Path.home() / "projects" / "watchdog" / "watchdog-monorepo"
    if local_path.exists():
        return str(local_path)

    return f"https://github.com/{DEFAULT_REPO_OWNER}/{DEFAULT_REPO_NAME}.git"


def reserve_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def parse_model(model: str) -> tuple[str, str]:
    if "/" not in model:
        return "anthropic", model
    provider, model_id = model.split("/", 1)
    return provider, model_id


def runtime_dir() -> Path:
    return Path(sandbox_runtime.__file__).parent


def clean_workdir(workdir: Path, *, force: bool) -> None:
    if not workdir.exists():
        return

    if not force:
        raise SystemExit(
            f"Workdir already exists: {workdir}\n"
            "Pass --force to remove it, or choose another --workdir."
        )

    shutil.rmtree(workdir)


def clone_repo(args: argparse.Namespace, paths: SmokePaths) -> None:
    repo_source = str(args.repo_source)
    source_path = Path(repo_source).expanduser()
    source = str(source_path) if source_path.exists() else repo_source

    command = ["git", "clone"]
    if source_path.exists():
        command.append("--no-local")
    elif args.depth > 0:
        command.extend(["--depth", str(args.depth)])
    command.extend([source, str(paths.repo_dir)])
    run_command(command)

    if args.set_github_origin:
        github_url = f"https://github.com/{args.repo_owner}/{args.repo_name}.git"
        run_command(["git", "remote", "set-url", "origin", github_url], cwd=paths.repo_dir)

    if args.ref:
        run_command(["git", "fetch", "origin", args.ref, "--depth", "1"], cwd=paths.repo_dir)
        run_command(["git", "checkout", "FETCH_HEAD"], cwd=paths.repo_dir)


def copytree_contents(source: Path, dest: Path) -> None:
    if not source.is_dir():
        return
    dest.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        target = dest / child.name
        if child.is_dir():
            shutil.copytree(
                child,
                target,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                symlinks=True,
            )
        elif child.is_file():
            shutil.copy2(child, target)


def install_runtime_opencode_files(args: argparse.Namespace, repo_dir: Path) -> None:
    opencode_dir = repo_dir / ".opencode"
    if args.clean_opencode and opencode_dir.exists():
        shutil.rmtree(opencode_dir)

    rt_dir = runtime_dir()
    copytree_contents(rt_dir / "skills", opencode_dir / "skills")

    if args.install_tools:
        tool_dest = opencode_dir / "tools"
        tool_dest.mkdir(parents=True, exist_ok=True)

        legacy_tool = rt_dir / "plugins" / "inspect-plugin.js"
        if legacy_tool.exists():
            shutil.copy2(legacy_tool, tool_dest / "create-pull-request.js")

        tools_dir = rt_dir / "tools"
        if tools_dir.is_dir():
            for tool_file in tools_dir.iterdir():
                if tool_file.is_file() and tool_file.suffix == ".js":
                    gate_env = AGENT_TOOLS_GATED_ON_ENV.get(tool_file.name)
                    if gate_env and os.environ.get(gate_env, "").lower() != "true":
                        continue
                    shutil.copy2(tool_file, tool_dest / tool_file.name)

        package_json = opencode_dir / "package.json"
        if not package_json.exists():
            package_json.write_text(
                json.dumps(
                    {
                        "name": "openinspect-local-smoke-tools",
                        "type": "module",
                        "private": True,
                        "dependencies": {
                            "@opencode-ai/plugin": args.opencode_plugin_version,
                        },
                    },
                    indent=2,
                )
                + "\n"
            )

        if args.npm_install_tools:
            run_command(
                [
                    "npm",
                    "install",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                ],
                cwd=opencode_dir,
                timeout_seconds=args.npm_timeout_seconds,
            )


def prepare_checkout(args: argparse.Namespace) -> SmokePaths:
    workdir = Path(args.workdir).expanduser().resolve()
    clean_workdir(workdir, force=args.force)
    workdir.mkdir(parents=True, exist_ok=True)

    paths = SmokePaths(
        workdir=workdir,
        repo_dir=workdir / args.repo_name,
        event_log=workdir / "events.jsonl",
        opencode_log=workdir / "opencode.log",
        opencode_runner_dir=workdir / ".opencode-runner",
        home_dir=workdir / "home",
    )

    clone_repo(args, paths)
    install_runtime_opencode_files(args, paths.repo_dir)
    return paths


def copy_local_opencode_auth(paths: SmokePaths) -> None:
    """Copy local OpenCode auth into the isolated HOME used by the smoke run."""
    source = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    if not source.exists():
        return

    dest = paths.home_dir / ".local" / "share" / "opencode" / "auth.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    dest.chmod(0o600)


def local_gh_token() -> str:
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        eprint(f"GitHub CLI token unavailable for smoke run: {type(exc).__name__}")
        return ""
    return result.stdout.strip()


async def wait_for_opencode(port: int, process: asyncio.subprocess.Process, timeout: float) -> None:
    health_url = f"http://127.0.0.1:{port}/global/health"
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as client:
        while time.monotonic() < deadline:
            if process.returncode is not None:
                raise RuntimeError(f"OpenCode exited before health check: {process.returncode}")
            try:
                response = await client.get(health_url, timeout=1.0)
                if response.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.25)
    raise TimeoutError(f"OpenCode did not become healthy within {timeout:.1f}s")


async def forward_process_output(
    process: asyncio.subprocess.Process,
    log_path: Path,
    *,
    verbose: bool,
) -> None:
    if process.stdout is None:
        return

    with log_path.open("a") as log_file:
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            decoded = line.decode(errors="replace").rstrip()
            log_file.write(decoded + "\n")
            log_file.flush()
            if verbose:
                eprint(f"[opencode] {decoded}")


def opencode_binary(args: argparse.Namespace, paths: SmokePaths) -> str:
    if not args.opencode_version:
        return str(args.opencode_binary)

    package_json = paths.opencode_runner_dir / "package.json"
    binary_path = paths.opencode_runner_dir / "node_modules" / ".bin" / "opencode"
    paths.opencode_runner_dir.mkdir(parents=True, exist_ok=True)
    if not package_json.exists():
        package_json.write_text(
            json.dumps(
                {
                    "name": "openinspect-local-opencode-runner",
                    "private": True,
                    "dependencies": {"opencode-ai": args.opencode_version},
                },
                indent=2,
            )
            + "\n"
        )
    if not binary_path.exists():
        run_command(
            [
                "npm",
                "install",
                "--no-audit",
                "--no-fund",
            ],
            cwd=paths.opencode_runner_dir,
            timeout_seconds=args.npm_timeout_seconds,
        )
    return str(binary_path)


def opencode_command(args: argparse.Namespace, paths: SmokePaths, port: int) -> list[str]:
    binary = opencode_binary(args, paths)

    return [
        binary,
        "serve",
        "--port",
        str(port),
        "--hostname",
        "127.0.0.1",
        "--print-logs",
        "--log-level",
        args.opencode_log_level,
    ]


async def start_opencode(
    args: argparse.Namespace,
    paths: SmokePaths,
    port: int,
) -> tuple[asyncio.subprocess.Process, asyncio.Task[None]]:
    provider_id, model_id = parse_model(args.model)
    opencode_config: dict[str, Any] = {
        "model": f"{provider_id}/{model_id}",
        "autoupdate": False,
        "permission": {
            "*": "allow",
            "doom_loop": "deny",
        },
    }

    session_config = {
        "sessionId": "local-smoke-session",
        "session_id": "local-smoke-session",
        "provider": provider_id,
        "model": model_id,
        "branch": args.branch,
    }

    if args.copy_opencode_auth:
        copy_local_opencode_auth(paths)

    gh_token = os.environ.get("GH_TOKEN", "")
    if args.copy_gh_token and not gh_token:
        gh_token = local_gh_token()

    env = {
        **os.environ,
        "HOME": str(paths.home_dir),
        "XDG_DATA_HOME": str(paths.home_dir / ".local" / "share"),
        "XDG_CONFIG_HOME": str(paths.home_dir / ".config"),
        "XDG_CACHE_HOME": str(paths.home_dir / ".cache"),
        "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
        "OPENCODE_CLIENT": "serve",
        "CONTROL_PLANE_URL": args.control_plane_url,
        "SANDBOX_AUTH_TOKEN": args.sandbox_auth_token,
        "SESSION_CONFIG": json.dumps(session_config),
        "REPO_OWNER": args.repo_owner,
        "REPO_NAME": args.repo_name,
    }
    if gh_token:
        env["GH_TOKEN"] = gh_token

    command = opencode_command(args, paths, port)
    eprint(f"$ {' '.join(command)}  # cwd={paths.repo_dir}")
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=paths.repo_dir,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    forwarder = asyncio.create_task(
        forward_process_output(process, paths.opencode_log, verbose=args.verbose_opencode)
    )
    await wait_for_opencode(port, process, args.startup_timeout_seconds)
    return process, forwarder


def tool_call_key(event: dict[str, Any], fallback: int) -> str:
    call_id = str(event.get("callId") or "")
    tool = str(event.get("tool") or "")
    if call_id:
        return f"{tool}:{call_id}"
    return f"{tool}:event-{fallback}"


def summarize_event(event: dict[str, Any]) -> str:
    event_type = str(event.get("type", ""))
    if event_type == "tool_call":
        tool = event.get("tool", "")
        args = event.get("args") if isinstance(event.get("args"), dict) else {}
        status = event.get("status", "")
        if tool == "skill":
            return f"tool_call skill({args.get('name', '')}) status={status}"
        return f"tool_call {tool} status={status}"
    if event_type == "token":
        content = str(event.get("content", "")).replace("\n", " ")
        return f"token {content[:100]}"
    if event_type == "step_finish":
        return f"step_finish reason={event.get('reason', '')}"
    if event_type == "error":
        return f"error {event.get('error', '')}"
    return event_type


def update_counters(
    counters: SmokeCounters,
    event: dict[str, Any],
    *,
    skill_name: str,
) -> None:
    counters.events_seen += 1
    event_type = event.get("type")
    if event_type == "token":
        counters.tokens_seen += 1
    elif event_type == "step_finish":
        counters.step_finish_seen += 1
    elif event_type == "error":
        counters.errors_seen += 1
    elif event_type == "tool_call":
        tool = event.get("tool")
        args = event.get("args") if isinstance(event.get("args"), dict) else {}
        key = tool_call_key(event, counters.events_seen)
        if tool == "skill" and args.get("name") == skill_name:
            counters.skill_call_ids.add(key)
        elif tool != "skill":
            counters.non_skill_tool_call_ids.add(key)


async def run_prompt(
    args: argparse.Namespace,
    paths: SmokePaths,
    port: int,
) -> SmokeCounters:
    bridge = AgentBridge(
        sandbox_id="local-smoke-sandbox",
        session_id="local-smoke-session",
        control_plane_url=args.control_plane_url,
        auth_token=args.sandbox_auth_token,
        opencode_port=port,
    )
    bridge.repo_path = paths.workdir
    bridge.session_id_file = paths.workdir / "opencode-session-id"
    bridge.http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(bridge.HTTP_DEFAULT_TIMEOUT, connect=bridge.HTTP_CONNECT_TIMEOUT)
    )
    bridge.PROMPT_MAX_DURATION = args.prompt_timeout_seconds
    counters = SmokeCounters(skill_call_ids=set(), non_skill_tool_call_ids=set())

    async def write_event(event: dict[str, Any]) -> None:
        update_counters(counters, event, skill_name=args.skill_name)
        record = {
            "sequence": counters.events_seen,
            "timestamp": time.time(),
            "event": event,
        }
        with paths.event_log.open("a") as event_file:
            event_file.write(json.dumps(record, default=str) + "\n")
        print(f"{counters.events_seen:04d} {summarize_event(event)}", flush=True)

    try:
        await bridge._configure_git_identity(FALLBACK_GIT_USER)
        await bridge._create_opencode_session()

        async with asyncio.timeout(args.prompt_timeout_seconds):
            async for event in bridge._stream_opencode_response_sse(
                "local-smoke-message",
                args.prompt,
                args.model,
                args.reasoning_effort,
            ):
                await write_event(event)

                if counters.events_seen >= args.max_events:
                    await bridge._request_opencode_stop(reason="local_smoke_max_events")
                    raise RuntimeError(f"Reached --max-events={args.max_events}")

                if (
                    args.stop_on_skill_loop
                    and len(counters.skill_call_ids) > args.max_skill_calls_before_work
                    and not counters.non_skill_tool_call_ids
                ):
                    counters.loop_detected = True
                    await bridge._request_opencode_stop(reason="local_smoke_skill_loop")
                    break

        counters.completed = not counters.loop_detected and counters.errors_seen == 0
        return counters

    except TimeoutError:
        await bridge._request_opencode_stop(reason="local_smoke_timeout")
        raise
    finally:
        if bridge.http_client:
            await bridge.http_client.aclose()


async def terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return

    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        except Exception:
            process.kill()
        await process.wait()


async def async_main(args: argparse.Namespace) -> int:
    paths = prepare_checkout(args)
    port = args.opencode_port or reserve_free_port()

    eprint(f"workdir: {paths.workdir}")
    eprint(f"repo: {paths.repo_dir}")
    eprint(f"events: {paths.event_log}")
    eprint(f"opencode logs: {paths.opencode_log}")

    process: asyncio.subprocess.Process | None = None
    forwarder: asyncio.Task[None] | None = None
    try:
        process, forwarder = await start_opencode(args, paths, port)
        counters = await run_prompt(args, paths, port)
    finally:
        if process is not None:
            await terminate_process(process)
        if forwarder is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await forwarder

    print(
        json.dumps(
            {
                "events": counters.events_seen,
                "skill_calls": len(counters.skill_call_ids),
                "non_skill_tool_calls": len(counters.non_skill_tool_call_ids),
                "tokens": counters.tokens_seen,
                "step_finish": counters.step_finish_seen,
                "errors": counters.errors_seen,
                "loop_detected": counters.loop_detected,
                "completed": counters.completed,
                "event_log": str(paths.event_log),
                "opencode_log": str(paths.opencode_log),
            },
            indent=2,
        )
    )

    if counters.loop_detected:
        return 2
    if counters.errors_seen:
        return 4
    if args.require_non_skill_tool and not counters.non_skill_tool_call_ids:
        eprint("No non-skill tool call was observed.")
        return 3
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a local OpenCode + AgentBridge smoke prompt against a real repo."
    )
    parser.add_argument("--repo-source", default=default_repo_source())
    parser.add_argument("--repo-owner", default=DEFAULT_REPO_OWNER)
    parser.add_argument("--repo-name", default=DEFAULT_REPO_NAME)
    parser.add_argument("--ref", default="")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--depth", type=int, default=1)
    parser.add_argument(
        "--set-github-origin",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Set origin to https://github.com/<repo-owner>/<repo-name>.git after cloning.",
    )
    parser.add_argument("--workdir", default=str(DEFAULT_WORKDIR))
    parser.add_argument("--force", action="store_true", help="Remove --workdir before running.")
    parser.add_argument(
        "--clean-opencode",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Delete any repo .opencode before installing runtime skills/tools.",
    )
    parser.add_argument(
        "--install-tools",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Copy bundled OpenCode tools in addition to skills.",
    )
    parser.add_argument(
        "--npm-install-tools",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Run npm install in .opencode for tool/plugin dependencies.",
    )
    parser.add_argument("--npm-timeout-seconds", type=int, default=120)

    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--reasoning-effort", default=DEFAULT_REASONING_EFFORT)
    parser.add_argument("--skill-name", default="code-review")
    parser.add_argument("--max-skill-calls-before-work", type=int, default=3)
    parser.add_argument("--max-events", type=int, default=300)
    parser.add_argument("--prompt-timeout-seconds", type=float, default=600)
    parser.add_argument(
        "--require-non-skill-tool", action=argparse.BooleanOptionalAction, default=True
    )
    parser.add_argument("--stop-on-skill-loop", action=argparse.BooleanOptionalAction, default=True)

    parser.add_argument("--opencode-binary", default="opencode")
    parser.add_argument(
        "--opencode-version",
        default="",
        help=(
            "Install and run opencode-ai@VERSION in an isolated runner. Empty uses "
            "--opencode-binary. "
            f"Production is currently {DEFAULT_OPENCODE_VERSION}."
        ),
    )
    parser.add_argument("--opencode-plugin-version", default=DEFAULT_OPENCODE_VERSION)
    parser.add_argument("--opencode-port", type=int, default=0)
    parser.add_argument("--opencode-log-level", default="INFO")
    parser.add_argument("--startup-timeout-seconds", type=float, default=60)
    parser.add_argument("--verbose-opencode", action="store_true")
    parser.add_argument(
        "--copy-opencode-auth",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Copy ~/.local/share/opencode/auth.json into the isolated HOME for local model auth.",
    )
    parser.add_argument(
        "--copy-gh-token",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Pass `gh auth token` as GH_TOKEN into the isolated OpenCode process.",
    )

    parser.add_argument("--control-plane-url", default="http://localhost:8787")
    parser.add_argument("--sandbox-auth-token", default="local-smoke-token")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        eprint(f"local prompt smoke failed: {type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
