# Using Claude Subscription Models

Open-Inspect can run coding sessions against Claude models using a **Claude Pro/Max subscription**
OAuth token instead of metered, pay-per-token API billing. In our deployment, this is the default
Anthropic model path.

## Supported Models

| Model             | Model ID            | Notes                            |
| ----------------- | ------------------- | -------------------------------- |
| Claude Haiku 4.5  | `claude-haiku-4-5`  | Faster, cheaper; lighter tasks.  |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Balanced general-purpose model.  |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Balanced general-purpose model.  |
| Claude Opus 4.5   | `claude-opus-4-5`   | Most capable; complex reasoning. |
| Claude Opus 4.6   | `claude-opus-4-6`   | Most capable; complex reasoning. |
| Claude Opus 4.7   | `claude-opus-4-7`   | Most capable; complex reasoning. |
| Claude Opus 4.8   | `claude-opus-4-8`   | Most capable; complex reasoning. |

## Setup

### Step 1 — Obtain Claude OAuth credentials

Run the helper script from the repo root:

```bash
node scripts/claude-oauth-login.mjs
```

This prints a `claude.ai` OAuth URL. Open it in a browser, authorize, and paste the resulting code
back into the terminal. The script then prints a **refresh token**. Copy it.

The helper uses Claude Code-compatible public PKCE defaults. They are public-client parameters, not
Open-Inspect secrets. If Anthropic issues different OAuth values for this deployment, override them
when running the helper:

```bash
ANTHROPIC_OAUTH_CLIENT_ID="..." \
ANTHROPIC_OAUTH_TOKEN_URL="..." \
ANTHROPIC_OAUTH_REDIRECT_URI="..." \
ANTHROPIC_OAUTH_SCOPES="..." \
node scripts/claude-oauth-login.mjs
```

Set matching `anthropic_oauth_client_id` and `anthropic_oauth_token_url` Terraform variables if the
control plane also needs to use non-default OAuth values. Do not add those values as repo/global
secrets; they are reserved system configuration keys.

Alternatively, if you already use Claude in a local tool (such as `opencode` or the Claude Code
CLI), you can read the refresh token from that tool's local `auth.json`.

### Step 2 — Add the secret

In the Open-Inspect web UI, go to **Settings** and add a secret:

| Secret name                     | Scope          | Value                          |
| ------------------------------- | -------------- | ------------------------------ |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | Global or repo | The refresh token from Step 1. |

Secrets can be scoped **globally** (all repos) or to a **specific repo**. Repo-scoped secrets take
precedence over global ones.

### Step 3 — Select a Claude model

When starting a session, pick one of the supported Claude models from the model dropdown. That's it.

## How It Works

1. The refresh token is stored encrypted in the control plane (D1). It is **never** exposed to the
   sandbox.
2. When a session starts, the sandbox requests a short-lived **access token** from the control
   plane's `/anthropic-token-refresh` endpoint.
3. The control plane uses the stored refresh token to mint a new access token and returns it.
4. Token rotation is handled centrally — if Anthropic rotates the refresh token, the control plane
   persists the new value automatically.
5. Tokens are resolved **repo-first, then global**: a repo-scoped token overrides the global one.

If no OAuth refresh token is configured, the system can fall back to the `ANTHROPIC_API_KEY` secret
for deployments that intentionally use metered API billing.

## Troubleshooting

**Model fails to start.** Confirm the `ANTHROPIC_OAUTH_REFRESH_TOKEN` secret is set and valid. Check
the session logs for token-refresh errors.

**"token refresh failed".** The refresh token was revoked or expired. Re-run
`node scripts/claude-oauth-login.mjs` to obtain a new one and update the secret.

**Important.** This uses your personal Claude subscription credentials. It is intended for internal
team use only and may be subject to Anthropic's usage policies.
