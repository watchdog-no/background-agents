"""Tests for anthropic auth proxy plugin deployment in SandboxSupervisor."""

import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with default test config."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


def _auth_file(tmp_path: Path) -> Path:
    """Return the expected auth.json path under tmp_path."""
    return tmp_path / ".local" / "share" / "opencode" / "auth.json"


class TestAnthropicAuthPluginSetup:
    """Cases for anthropic auth proxy plugin deployment."""

    def test_auth_json_uses_sentinel_token(self, tmp_path):
        """auth.json should contain the sentinel, not the real refresh token."""
        sup = _make_supervisor()

        with (
            patch.dict(
                "os.environ",
                {"ANTHROPIC_OAUTH_ENABLED": "true"},
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_anthropic_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["anthropic"]["refresh"] == "managed-by-control-plane"
        assert data["anthropic"]["type"] == "oauth"
        assert data["anthropic"]["access"] == ""
        assert data["anthropic"]["expires"] == 0
        # Anthropic has no per-account header equivalent.
        assert "accountId" not in data["anthropic"]

    async def test_start_opencode_copies_js_plugin(self, tmp_path):
        """start_opencode() should deploy the precompiled JS plugin into .opencode/plugins."""
        sup = _make_supervisor()
        sup.workspace_path = tmp_path / "workspace"
        sup.workspace_path.mkdir()
        sup.repo_path = sup.workspace_path / "app"

        plugin_source = (
            tmp_path / "app" / "sandbox_runtime" / "plugins" / "anthropic-auth-plugin.js"
        )
        plugin_source.parent.mkdir(parents=True)
        plugin_source.write_text("export const AnthropicAuthProxy = async () => ({});")

        fake_proc = MagicMock()
        fake_proc.stdout = None

        original_path = Path

        with (
            patch.dict("os.environ", {"ANTHROPIC_OAUTH_ENABLED": "true"}, clear=False),
            patch("sandbox_runtime.entrypoint.Path") as mock_path,
            patch("sandbox_runtime.entrypoint.shutil.copy") as mock_copy,
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                AsyncMock(return_value=fake_proc),
            ),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_task",
                side_effect=lambda coro: coro.close(),
            ),
        ):
            # Resolve only the anthropic plugin source to an existing file. The
            # codex source must resolve to a non-existent path so that the codex
            # deploy block is skipped and only the anthropic copy fires.
            mock_path.side_effect = lambda p: (
                plugin_source
                if p == "/app/sandbox_runtime/plugins/anthropic-auth-plugin.js"
                else original_path(p)
            )
            sup._setup_openai_oauth = MagicMock()
            sup._setup_anthropic_oauth = MagicMock()
            sup._install_tools = MagicMock()
            sup._install_skills = MagicMock()
            sup._install_bin_scripts = MagicMock()
            sup._wait_for_health = AsyncMock()

            await sup.start_opencode()

        mock_copy.assert_called_once_with(
            plugin_source,
            sup.workspace_path / ".opencode" / "plugins" / "anthropic-auth-plugin.js",
        )

    async def test_start_opencode_skips_plugin_without_oauth_enabled(self, tmp_path):
        """Without the non-secret OAuth flag, the anthropic plugin must not be copied."""
        sup = _make_supervisor()
        sup.workspace_path = tmp_path / "workspace"
        sup.workspace_path.mkdir()
        sup.repo_path = sup.workspace_path / "app"

        plugin_source = (
            tmp_path / "app" / "sandbox_runtime" / "plugins" / "anthropic-auth-plugin.js"
        )
        plugin_source.parent.mkdir(parents=True)
        plugin_source.write_text("export const AnthropicAuthProxy = async () => ({});")

        fake_proc = MagicMock()
        fake_proc.stdout = None

        original_path = Path

        with (
            patch.dict("os.environ", {"ANTHROPIC_OAUTH_ENABLED": ""}, clear=False),
            patch("sandbox_runtime.entrypoint.Path") as mock_path,
            patch("sandbox_runtime.entrypoint.shutil.copy") as mock_copy,
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                AsyncMock(return_value=fake_proc),
            ),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_task",
                side_effect=lambda coro: coro.close(),
            ),
        ):
            mock_path.side_effect = lambda p: (
                plugin_source
                if p == "/app/sandbox_runtime/plugins/anthropic-auth-plugin.js"
                else original_path(p)
            )
            sup._setup_openai_oauth = MagicMock()
            sup._setup_anthropic_oauth = MagicMock()
            sup._install_tools = MagicMock()
            sup._install_skills = MagicMock()
            sup._install_bin_scripts = MagicMock()
            sup._wait_for_health = AsyncMock()

            await sup.start_opencode()

        for call in mock_copy.call_args_list:
            dest = call.args[1]
            assert dest.name != "anthropic-auth-plugin.js"

    def test_provider_models_hook_zeroes_oauth_costs(self):
        """OAuth-backed Anthropic models should report zero subscription cost."""
        plugin_path = (
            Path(__file__).parents[1]
            / "src"
            / "sandbox_runtime"
            / "plugins"
            / "anthropic-auth-plugin.js"
        )
        script = f"""
            import {{ AnthropicAuthProxy }} from {json.dumps(plugin_path.as_uri())};

            const plugin = await AnthropicAuthProxy({{
              client: {{ auth: {{ set: async () => {{}} }} }},
            }});

            const models = await plugin.provider.models(
              {{
                id: "anthropic",
                models: {{
                  "claude-test": {{
                    name: "Claude Test",
                    cost: {{
                      input: 3,
                      output: 15,
                      cache: {{ read: 0.3, write: 3.75 }},
                      tiers: [
                        {{
                          input: 6,
                          output: 22.5,
                          cache: {{ read: 0.6, write: 7.5 }},
                          tier: {{ type: "context", size: 200000 }},
                        }},
                      ],
                    }},
                  }},
                }},
              }},
              {{ auth: {{ type: "oauth", refresh: "sentinel", access: "", expires: 0 }} }}
            );

            console.log(JSON.stringify(models["claude-test"].cost));
        """

        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )

        assert json.loads(result.stdout) == {
            "input": 0,
            "output": 0,
            "cache": {"read": 0, "write": 0},
            "tiers": [
                {
                    "input": 0,
                    "output": 0,
                    "cache": {"read": 0, "write": 0},
                    "tier": {"type": "context", "size": 200000},
                }
            ],
        }
