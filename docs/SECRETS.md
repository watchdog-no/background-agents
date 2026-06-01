# Secrets Management

Open-Inspect lets you store environment variables — API keys, database URLs, credentials — and use
them in sandboxes and control-plane workflows. Secrets are encrypted at rest and masked by default
in the UI.

---

## Quick Start

1. Open your Open-Inspect web app and go to **Settings**
2. The **Secrets** tab is selected by default
3. Use the scope dropdown at the top to choose **All Repositories (Global)** or a specific
   repository
4. Click **Add secret**, enter a key and value, then click **Save**

That's it — the next sandbox you launch will have the secret available as an environment variable,
unless the key is control-plane-only OAuth token material.

---

## Global vs. Repository Secrets

| Scope          | Applies to        | Use case                                                                             |
| -------------- | ----------------- | ------------------------------------------------------------------------------------ |
| **Global**     | All repositories  | Credentials shared across projects (`ANTHROPIC_OAUTH_REFRESH_TOKEN`, `DATABASE_URL`) |
| **Repository** | One specific repo | Repo-specific credentials (`STRIPE_SECRET_KEY`, `AWS_ACCESS_KEY_ID`)                 |

**Precedence**: Repository secrets override global secrets with the same key. When viewing a
repository's secrets, inherited global keys are shown in a read-only section with a "Global" badge.
If you override a global key at the repo level, the global entry shows "(overridden by repo)."

### When to use global secrets

Use global secrets for keys that apply regardless of which repository a session runs against. The
most common examples:

| Key                             | Description                                                           |
| ------------------------------- | --------------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | Claude subscription OAuth token for the default Anthropic model path. |
| `OPENAI_OAUTH_REFRESH_TOKEN`    | ChatGPT subscription OAuth token for OpenAI models.                   |
| `OPENAI_OAUTH_ACCOUNT_ID`       | Account ID paired with the OpenAI OAuth refresh token.                |
| `ANTHROPIC_API_KEY`             | Optional metered Claude API key for control-plane classification.     |
| `OPENAI_API_KEY`                | Optional metered OpenAI API key for control-plane classification.     |

> **Daytona users**: For the default Claude subscription path, add `ANTHROPIC_OAUTH_REFRESH_TOKEN`
> as a global secret after deploying. Add provider API keys only if you intentionally want those
> standard SDK credentials available to sandbox code.

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
| Key format                       | `[A-Za-z_][A-Za-z0-9_]*` (letters, digits, underscores) |

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

---

## Common Examples

| Key                             | Scope  | Purpose                                                         |
| ------------------------------- | ------ | --------------------------------------------------------------- |
| `ANTHROPIC_OAUTH_REFRESH_TOKEN` | Global | Claude subscription access ([setup guide](ANTHROPIC_MODELS.md)) |
| `ANTHROPIC_API_KEY`             | Global | Optional Claude API key for control-plane classification        |
| `OPENAI_API_KEY`                | Global | Optional OpenAI API key for control-plane classification        |
| `OPENAI_OAUTH_REFRESH_TOKEN`    | Repo   | OpenAI Codex access ([setup guide](OPENAI_MODELS.md))           |
| `OPENAI_OAUTH_ACCOUNT_ID`       | Repo   | OpenAI Codex access ([setup guide](OPENAI_MODELS.md))           |
| `DATABASE_URL`                  | Repo   | Database connection string                                      |
| `AWS_ACCESS_KEY_ID`             | Repo   | AWS credentials for a specific project                          |
| `STRIPE_SECRET_KEY`             | Repo   | Stripe API key for a specific project                           |

---

## Troubleshooting

### "Model not found" errors (Daytona provider)

If you're using `sandbox_provider = "daytona"` with Claude models and see "Model not found" errors,
confirm that `ANTHROPIC_OAUTH_REFRESH_TOKEN` is saved as a global or repo secret. Add
`ANTHROPIC_API_KEY` only if you intentionally use metered API billing.

### Secret not appearing in sandbox

1. Verify the secret is saved under the correct scope (global or the specific repo)
2. Check that the key isn't in the reserved keys list above or a control-plane-only OAuth key
3. New secrets only apply to **new** sandboxes — restart your session to pick up changes

### Key name was auto-changed

Keys are automatically uppercased when saved. `my_api_key` becomes `MY_API_KEY`.
