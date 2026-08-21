# Secrets Management

Open-Inspect lets you store environment variables — API keys, database URLs, credentials — and use
them in sandboxes and control-plane workflows. Secrets are encrypted at rest and masked by default
in the UI. Managed OAuth refresh tokens are brokered by the control plane instead of being injected
into sandboxes.

---

## Quick Start

1. Open your Open-Inspect web app and go to **Settings**
2. Navigate to the scope you want:
   - **Global or repository secrets**: the **Secrets** tab (selected by default) — use the scope
     dropdown at the top to choose **All Repositories (Global)** or a specific repository
   - **Environment secrets**: the **Environments** tab — open the environment and switch to its
     **Secrets** tab
3. Click **Add secret**, enter a key and value, then click **Save**

That's it — the next sandbox you launch from that scope will have the secret available as an
environment variable, unless the key is control-plane-only OAuth token material.

---

## Secret Scopes

| Scope           | Applies to                              | Use case                                                                              |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| **Global**      | All sessions                            | Credentials shared across projects (`ANTHROPIC_OAUTH_REFRESH_TOKEN`, `ZHIPU_API_KEY`) |
| **Repository**  | Sessions launched from that repo        | Repo-specific credentials (`STRIPE_SECRET_KEY`, `AWS_ACCESS_KEY_ID`)                  |
| **Environment** | Sessions launched from that environment | Credentials curated for a multi-repository environment (see below)                    |

Global and repository secrets are managed under **Settings > Secrets**; environment secrets are
managed on the **Secrets** tab of each environment under **Settings > Environments**.

**Precedence**: Repository (or environment) secrets override global secrets with the same key. When
viewing a repository's secrets, inherited global keys are shown in a read-only section with a
"Global" badge. If you override a global key at the repo or environment level, the global entry
shows which scope overrode it.

### Which secrets a session receives

A session receives **global secrets plus its session target's secrets** — the session target is
whatever you picked when creating the session:

- **Single repository** (web picker, Slack, GitHub, Linear): global + that repository's secrets.
- **Environment**: global + that **environment's** secrets only. The repositories inside the
  environment do **not** contribute their repository secrets — environments are curated, so a key
  added to a repository never silently lands in every environment containing it. To reuse a
  repository secret, import it (below) or move it to global scope.
- **Ad-hoc multi-repository session** ("Multiple repositories" in the picker): global + each
  selected repository's secrets. On key collisions the **primary repository** (first in the list)
  wins.

The new-session picker states this disclosure for environment and multi-repository selections.

### Importing repository secrets into an environment

On an environment's **Secrets** tab you can import secrets from any repository that belongs to the
environment: pick the source repository, select the keys, and the values are copied
control-plane-side (never displayed). Imports are **copies** — if you later rotate the value on the
repository, re-import it or update the environment secret directly.

### When to use global secrets

Use global secrets for keys that apply regardless of which repository a session runs against. The
most common examples:

| Key                             | Description                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | Claude subscription OAuth token for the default Anthropic path.     |
| `OPENAI_OAUTH_REFRESH_TOKEN`    | ChatGPT subscription OAuth token for OpenAI models.                 |
| `OPENAI_OAUTH_ACCOUNT_ID`       | Account ID paired with the OpenAI OAuth refresh token.              |
| `ANTHROPIC_API_KEY`             | Optional metered Claude API key for standard SDK access.            |
| `OPENAI_API_KEY`                | Optional metered OpenAI API key for standard SDK access.            |
| `DEEPSEEK_API_KEY`              | Required for DeepSeek models with any sandbox provider.             |
| `ZHIPU_API_KEY`                 | Required for Z.AI Coding Plan GLM models with any sandbox provider. |

> **Daytona and Vercel sandbox users**: For the default Claude subscription path, add
> `ANTHROPIC_OAUTH_REFRESH_TOKEN` as a global secret after deploying. Add provider API keys only if
> you intentionally want those standard SDK credentials available to sandbox code.

### When to use repository secrets

Use repository secrets for credentials that are specific to a single project — database connection
strings, third-party API keys, service account tokens, etc.

---

## Adding Secrets

### From the Settings page

1. Go to **Settings > Secrets**
2. Select a scope (global or a specific repository)
3. Click **Add secret**
4. Enter the key name (automatically uppercased) and value
5. Click **Save**

For environment secrets, go to **Settings > Environments**, open the environment, and use its
**Secrets** tab — the editor works the same way.

### Paste a `.env` file

You can paste a `.env`-formatted block (e.g., `KEY=value`) into any input field. Open-Inspect will
automatically parse it and populate multiple rows — useful for bulk imports.

### Updating a secret

Existing secret values are masked by default. Reveal a value to inspect it, or edit the value and
click **Save** to update it.

### Deleting a secret

Click the delete button next to any secret row and confirm.

---

## Limits

| Constraint                       | Limit                                                   |
| -------------------------------- | ------------------------------------------------------- |
| Max secrets per scope            | 50                                                      |
| Max key length                   | 256 characters                                          |
| Max value size                   | 16 KB                                                   |
| Max total value size (per scope) | 64 KB                                                   |
| Max combined size per session    | 128 KB (global + session target, after merging)         |
| Key format                       | `[A-Za-z_][A-Za-z0-9_]*` (letters, digits, underscores) |

If the merged payload for a session (or an image build) exceeds the combined cap, the spawn fails
with an error that attributes bytes per contributing scope so you know what to trim. This mostly
matters for multi-repository sessions, where several repositories' secrets fold into one sandbox.

---

## Reserved Keys

Certain keys are reserved for system use and cannot be set as secrets:

`PYTHONUNBUFFERED`, `SANDBOX_ID`, `CONTROL_PLANE_URL`, `SANDBOX_AUTH_TOKEN`, `REPO_OWNER`,
`REPO_NAME`, `GITHUB_APP_TOKEN`, `SESSION_CONFIG`, `RESTORED_FROM_SNAPSHOT`,
`OPENCODE_CONFIG_CONTENT`, `ANTHROPIC_OAUTH_ENABLED`, `ANTHROPIC_OAUTH_AUTHORIZE_URL`,
`ANTHROPIC_OAUTH_CLIENT_ID`, `ANTHROPIC_OAUTH_TOKEN_URL`, `ANTHROPIC_OAUTH_REDIRECT_URI`,
`ANTHROPIC_OAUTH_SCOPES`, `PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `PWD`, `LANG`

If you try to save a reserved key, the UI will show a validation error.

---

## Security

- Secrets are encrypted with **AES-256-GCM** before being stored in the database
- Values are returned only to authenticated Settings users and are masked by default in the UI
- Most secrets are decrypted at sandbox creation time and injected as environment variables
- Anthropic OAuth refresh tokens and cached access-token secrets are control-plane-only; sandboxes
  receive only a non-secret enabled flag and short-lived access tokens through the internal refresh
  endpoint
- System variables (set by the control plane) always take precedence over user-defined secrets

OpenAI and xAI subscription credentials belong in **Settings > Provider Accounts**, not generic
Secrets. Their refresh and cached access tokens are encrypted with
`PROVIDER_ACCOUNTS_ENCRYPTION_KEY`, remain control-plane-only, and are never returned to the browser
or injected into sandboxes. A session pins an account ID, API-key mode, or legacy scoped-OAuth mode
and requests short-lived access through `POST /sessions/:id/provider-auth/:provider/access-token`.

Provider-account mode removes that provider's canonical API key from the sandbox environment so the
runtime cannot bypass the selected subscription. API-key mode continues to use ordinary global,
repository, or environment secrets.

### Legacy managed OAuth coexistence

Legacy scoped OpenAI/xAI OAuth remains supported for sessions pinned to it. Provider-account
defaults affect only sessions created afterward. **Settings > Provider Accounts** lists legacy key
locations across global, repository, and environment scopes:

```text
OPENAI_OAUTH_REFRESH_TOKEN
OPENAI_OAUTH_ACCESS_TOKEN
OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT
OPENAI_OAUTH_ACCOUNT_ID
XAI_OAUTH_REFRESH_TOKEN
XAI_OAUTH_ACCESS_TOKEN
XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT
```

Do not reuse the same rotating refresh token in both systems. Operators may remove legacy keys once
the legacy-bound sessions that depend on them are no longer needed.

### Secrets and prebuilt images

Image builds (repository images and environment images) run your `.openinspect/setup.sh` with the
same secrets a session would get. Anything the script **persists to disk** — an `.npmrc`, a `.env`
file, a downloaded credential — is captured in the image and re-served to every session that boots
from it, even after you rotate the secret. Two guidelines:

- **Avoid writing long-lived secrets to disk in `setup.sh`.** Read them from the environment at
  runtime (they are re-injected fresh on every session) instead of baking them into files.
- **Environment-secret changes invalidate prebuilt images automatically**: saving an environment's
  secrets supersedes its existing ready image and triggers a rebuild, so a revoked value cannot keep
  serving from an old image. Rotating **repository or global** secrets does _not_ invalidate images
  — stale on-disk material persists until the next commit-triggered rebuild, which is another reason
  to keep secrets out of the image filesystem.

---

## Common Examples

| Key                             | Scope  | Purpose                                                         |
| ------------------------------- | ------ | --------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | Global | Claude subscription access ([setup guide](ANTHROPIC_MODELS.md)) |
| `ANTHROPIC_API_KEY`             | Global | Optional Claude API key for metered SDK access                  |
| `DEEPSEEK_API_KEY`              | Global | DeepSeek API access                                             |
| `ZHIPU_API_KEY`                 | Global | Z.AI Coding Plan GLM access                                     |
| `OPENAI_API_KEY`                | Global | Optional OpenAI API key for metered SDK access                  |
| `OPENAI_OAUTH_REFRESH_TOKEN`    | Repo   | OpenAI Codex access ([setup guide](OPENAI_MODELS.md))           |
| `OPENAI_OAUTH_ACCOUNT_ID`       | Repo   | OpenAI Codex access ([setup guide](OPENAI_MODELS.md))           |
| `XAI_OAUTH_REFRESH_TOKEN`       | Any    | SuperGrok access ([setup guide](GROK_MODELS.md))                |
| `DATABASE_URL`                  | Repo   | Database connection string                                      |
| `AWS_ACCESS_KEY_ID`             | Repo   | AWS credentials for a specific project                          |
| `STRIPE_SECRET_KEY`             | Repo   | Stripe API key for a specific project                           |

---

## Troubleshooting

### "Model not found" errors

If you see "Model not found" errors, verify the selected provider authentication mode first. For
provider-account mode, verify the account and model entitlement. For the default Claude subscription
path on any sandbox provider, confirm that `ANTHROPIC_OAUTH_REFRESH_TOKEN` is saved as a global or
repository secret; add `ANTHROPIC_API_KEY` only for intentional metered API access. For API-key
mode, add the required key to the session's secret scope. DeepSeek uses `DEEPSEEK_API_KEY`; Z.AI
Coding Plan uses `ZHIPU_API_KEY`. For SuperGrok, follow the
[provider-account setup guide](GROK_MODELS.md).

### Secret not appearing in sandbox

1. Verify the secret is saved under the correct scope (global, the specific repo, or the
   environment)
2. Check that the key isn't in the reserved keys list above or a control-plane-only OAuth key
3. New secrets only apply to **new** sandboxes — restart your session to pick up changes
4. For sessions launched from an **environment**: repository secrets do not flow in. Add the key to
   the environment (or import it from the repository on the environment's Secrets tab).

### Key name was auto-changed

Keys are automatically uppercased when saved. `my_api_key` becomes `MY_API_KEY`.
