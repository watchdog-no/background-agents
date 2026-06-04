"""
Base image definition for Open-Inspect sandboxes.

This image provides a complete development environment with:
- Debian slim base with git, curl, build-essential
- Node.js 22 LTS, pnpm, Bun runtime
- Python 3.12 with uv
- OpenCode CLI pre-installed
- agent-browser CLI with headless Chrome for browser automation
- ffmpeg for browser video encoding
- ctx7 (Context7) CLI for up-to-date library documentation
- Sandbox entrypoint and bridge code
"""

from pathlib import Path

import modal

import sandbox_runtime

from .version import CACHE_BUSTER

# Get the path to the sandbox runtime code (provider-agnostic)
SANDBOX_RUNTIME_DIR = Path(sandbox_runtime.__file__).parent

# OpenCode version to install.
#
# Keep the CLI and plugin packages in lockstep. OpenCode 1.15.12 kept the OpenAI
# WebSocket response timeouts active and retried failed OpenAI WebSocket streams
# before falling back, fixing dropped/hung OpenAI responses seen on 1.15.10.
# 1.15.13 is the current pinned release.
OPENCODE_VERSION = "1.15.13"

# code-server version to install (pinned for reproducible images)
CODE_SERVER_VERSION = "4.109.5"

# agent-browser version to install (pinned for reproducible images)
AGENT_BROWSER_VERSION = "0.21.2"

# ttyd version to install (pinned for reproducible images)
TTYD_VERSION = "1.7.7"
TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"

# linear-cli version to install (pinned for reproducible images).
# Gives the agent read/write access to Linear via the `linear` CLI, paired with
# the linear-cli Skill. Authenticates from LINEAR_API_KEY, populated per spawn
# from the Linear app-actor token when available or from a user secret fallback.
LINEAR_CLI_VERSION = "2.0.0"

# ctx7 (Context7) version to install (pinned for reproducible images).
# Gives the agent up-to-date library/framework documentation via the `ctx7` CLI,
# paired with the context7 Skill. Auth is optional: it works anonymously
# (rate-limited) and reads CONTEXT7_API_KEY for higher limits, populated per spawn
# from a user secret when set in Settings → Secrets.
CTX7_VERSION = "0.4.4"

# Cache buster - change this to force Modal image rebuild
# v52: git credential helper backed by control plane; remove embedded VCS tokens
# v53: upgrade OpenCode to 1.15.10 after the SSE event subscription fix
# v54: install schpet/linear-cli for agent-side Linear access
# v55: install ctx7 (Context7) for agent-side library documentation
# v56: adopt upstream host-scoped SCM credential broker (PR #679)
# v57: upgrade OpenCode to 1.15.12 for the OpenAI WebSocket response fix
# v58: add Claude Pro/Max subscription OAuth path
# v59: add Claude Opus 4.8 model support
# v60: upgrade OpenCode to 1.15.13; inject Claude Code identity in the Anthropic
#      OAuth plugin so subscription requests are authorized (fixes spurious 429s)
# v64: match the official Claude Code SDK request envelope for Anthropic OAuth;
#      preserve the OpenCode prompt/tools instead of stripping request fragments

# Base image with all development tools
base_image = (
    modal.Image.debian_slim(python_version="3.12")
    # System packages
    .apt_install(
        "git",
        "curl",
        "build-essential",
        "ca-certificates",
        "gnupg",
        "openssh-client",
        "jq",
        "unzip",  # Required for Bun installation
        "ffmpeg",
        # Shared libraries required by headless Chromium
        "libnss3",
        "libnspr4",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdrm2",
        "libxkbcommon0",
        "libxcomposite1",
        "libxdamage1",
        "libxfixes3",
        "libxrandr2",
        "libgbm1",
        "libasound2",
        "libpango-1.0-0",
        "libcairo2",
    )
    # Install GitHub CLI (for agent-direct GitHub interaction via gh API)
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg"
        " | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg]"
        " https://cli.github.com/packages stable main'"
        " > /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
    )
    # Install Node.js 22 LTS
    .run_commands(
        # Add NodeSource repository for Node.js 22
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        # Verify installation
        "node --version",
        "npm --version",
    )
    # Install pnpm and Bun
    .run_commands(
        # Install pnpm globally
        "npm install -g pnpm@latest",
        "pnpm --version",
        # Install Bun
        "curl -fsSL https://bun.sh/install | bash",
        # Add Bun to PATH for subsequent commands
        'echo "export BUN_INSTALL="$HOME/.bun"" >> /etc/profile.d/bun.sh',
        'echo "export PATH="$BUN_INSTALL/bin:$PATH"" >> /etc/profile.d/bun.sh',
    )
    # Install Python tools
    .pip_install(
        "uv",
        "httpx",
        "websockets",
        "pydantic>=2.0",  # Required for sandbox types
        "PyJWT[crypto]",  # For GitHub App token generation (includes cryptography)
    )
    # Install OpenCode CLI and plugin for custom tools
    # CACHE_BUSTER is embedded in a no-op echo so Modal invalidates this layer on bump.
    .run_commands(
        f"echo 'cache: {CACHE_BUSTER}' > /dev/null",
        f"npm install -g opencode-ai@{OPENCODE_VERSION}",
        "opencode --version || echo 'OpenCode installed'",
        # Install @opencode-ai/plugin globally for custom tools
        # This ensures tools can import the plugin without needing to run bun add
        f"npm install -g @opencode-ai/plugin@{OPENCODE_VERSION} zod",
    )
    # Pre-build OpenCode plugin deps into a staging directory.
    # At boot, _install_tools() copies these into .opencode/ so that
    # OpenCode's Npm.install() finds package-lock.json in sync and skips
    # the slow arborist reify() call (2-22s) that would otherwise block
    # the first prompt and exceed the bridge's HTTP timeout.
    .run_commands(
        "mkdir -p /app/opencode-deps",
        # Pin staged plugin to OPENCODE_VERSION so the pre-staged tree copied
        # into .opencode/ at boot matches the globally installed plugin (#567).
        f'echo \'{{"name":"opencode-tools","type":"module",'
        f'"dependencies":{{"@opencode-ai/plugin":"{OPENCODE_VERSION}"}}}}\''
        " > /app/opencode-deps/package.json",
        "cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund",
    )
    # Install code-server for browser-based VS Code editing (direct .deb from GitHub releases)
    .run_commands(
        f"curl -fsSL -o /tmp/code-server.deb"
        f" https://github.com/coder/code-server/releases/download/v{CODE_SERVER_VERSION}"
        f"/code-server_{CODE_SERVER_VERSION}_amd64.deb",
        "dpkg -i /tmp/code-server.deb",
        "rm /tmp/code-server.deb",
        "code-server --version",
    )
    # Install ttyd web terminal (direct binary from GitHub releases)
    .run_commands(
        f"curl -fsSL -o /usr/local/bin/ttyd"
        f" https://github.com/tsl0922/ttyd/releases/download/{TTYD_VERSION}"
        f"/ttyd.x86_64",
        f'echo "{TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -',
        "chmod +x /usr/local/bin/ttyd",
        "ttyd --version",
    )
    # Install agent-browser CLI and download Chromium
    .run_commands(
        f"npm install -g agent-browser@{AGENT_BROWSER_VERSION}",
        "agent-browser install",
        "agent-browser --version",
    )
    # Install linear-cli (schpet/linear-cli) for agent-side Linear access.
    # The npm package fetches a platform-native binary at install time and
    # exposes it on PATH as `linear`. The agent authenticates via the
    # LINEAR_API_KEY env var (no `linear auth login` needed); see the
    # linear-cli Skill for usage.
    .run_commands(
        f"npm install -g @schpet/linear-cli@{LINEAR_CLI_VERSION}",
        "linear --version",
    )
    # Install ctx7 (Context7) for up-to-date library/framework documentation.
    # Exposes `ctx7` on PATH. Auth is optional: anonymous works (rate-limited),
    # CONTEXT7_API_KEY raises limits. See the context7 Skill for usage.
    .run_commands(
        f"npm install -g ctx7@{CTX7_VERSION}",
        "ctx7 --version",
    )
    # Create working directories
    .run_commands(
        "mkdir -p /workspace",
        "mkdir -p /app/plugins",
        "mkdir -p /tmp/opencode",
        "echo 'Image rebuilt at: v21-force-rebuild' > /app/image-version.txt",
    )
    # Install the git credential helper shim.
    #
    # Each `git` invocation in the sandbox runs this shim, which delegates to
    # the sandbox-runtime helper module. The helper talks to the control plane
    # to mint fresh per-request credentials, so git operations no longer rely
    # on a 1h-TTL token captured at sandbox creation time. Configured at the
    # system level so it applies before entrypoint.py has a chance to run
    # (e.g. when restoring a snapshot whose first action is a `git fetch`).
    .run_commands(
        "printf '%s\\n'"
        " '#!/bin/sh'"
        " 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
        " > /usr/local/bin/oi-git-credentials",
        "chmod 0755 /usr/local/bin/oi-git-credentials",
        "git config --system credential.helper /usr/local/bin/oi-git-credentials",
        # Pass the repo path to the helper so it can scope credentials to the
        # session repo, not just the host.
        "git config --system credential.useHttpPath true",
    )
    # Set environment variables (including cache buster to force rebuild)
    .env(
        {
            "HOME": "/root",
            "NODE_ENV": "development",
            "PNPM_HOME": "/root/.local/share/pnpm",
            "PATH": "/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin",
            "PYTHONPATH": "/app",
            "SANDBOX_VERSION": CACHE_BUSTER,
            # NODE_PATH for globally installed modules (used by custom tools)
            "NODE_PATH": "/usr/lib/node_modules",
        }
    )
    # Add sandbox runtime code to the image (provider-agnostic bridge, entrypoint, tools, plugins)
    .add_local_dir(
        str(SANDBOX_RUNTIME_DIR),
        remote_path="/app/sandbox_runtime",
    )
)

# Image variant optimized for Node.js/TypeScript projects
node_image = base_image.run_commands(
    # Pre-cache common Node.js development dependencies
    "npm cache clean --force",
)

# Image variant optimized for Python projects
python_image = base_image.run_commands(
    # Pre-create virtual environment
    "uv venv /workspace/.venv",
)
