#!/usr/bin/env node
/**
 * Verify a Claude Pro/Max subscription OAuth refresh token end to end.
 *
 * Mirrors what Open-Inspect does in production:
 *   1. Refresh: exchange the refresh token for a short-lived access token
 *      (same call as control-plane src/auth/anthropic.ts).
 *   2. Inference: call the Messages API with that access token plus the
 *      `anthropic-beta: oauth-2025-04-20` header (same as the sandbox
 *      anthropic-auth-plugin.js), proving the subscription path works.
 *
 * Reads ANTHROPIC_OAUTH_REFRESH_TOKEN from the environment, or from a file
 * passed as the first arg (e.g. .env-tmp). Secret values are masked unless an
 * env-sourced refresh token rotates; then the replacement is printed once so
 * it is not lost after Anthropic invalidates the previous token.
 *
 * Usage:
 *   node scripts/verify-anthropic-token.mjs .env-tmp
 *   ANTHROPIC_OAUTH_REFRESH_TOKEN=sk-ant-ort-... node scripts/verify-anthropic-token.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA = "oauth-2025-04-20";
const MODEL = process.env.VERIFY_MODEL || "claude-sonnet-4-6";

function mask(s) {
  if (!s) return "(missing)";
  return `${s.slice(0, 8)}…${s.slice(-4)} (len=${s.length})`;
}

// Accept either the canonical secret name or a plain TOKEN= line.
const KEY_NAMES = ["ANTHROPIC_OAUTH_REFRESH_TOKEN", "TOKEN"];

function loadRefreshToken() {
  for (const key of KEY_NAMES) {
    if (process.env[key]) return { token: process.env[key].trim(), file: null, key };
  }
  const file = process.argv[2];
  if (file) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const key of KEY_NAMES) {
      const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
      for (const line of lines) {
        const m = line.match(re);
        if (m) return { token: m[1].trim().replace(/^["']|["']$/g, ""), file, key };
      }
    }
  }
  return { token: null, file: null, key: null };
}

// Persist a rotated refresh token back to its source file so verifying never
// loses it (Anthropic invalidates the old token the moment it is used).
function persistRotatedToken({ file, key }, newToken) {
  if (!file) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`);
  const updated = lines.map((line) => (re.test(line) ? line.replace(re, `$1${newToken}`) : line));
  writeFileSync(file, updated.join("\n"));
  return true;
}

async function main() {
  const source = loadRefreshToken();
  const refreshToken = source.token;
  if (!refreshToken) {
    console.error(
      "No refresh token found. Pass a file (e.g. .env-tmp) with an ANTHROPIC_OAUTH_REFRESH_TOKEN= " +
        "or TOKEN= line, or set one of those env vars."
    );
    process.exit(2);
  }
  console.log("Refresh token:", mask(refreshToken), source.file ? `(from ${source.file})` : "");

  // --- Step 1: refresh -> access token ---
  console.log("\n[1/2] Refreshing access token …");
  const refreshRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!refreshRes.ok) {
    const body = await refreshRes.text();
    console.error(`  ✗ Refresh failed: ${refreshRes.status}`);
    console.error("  Body:", body.slice(0, 400));
    process.exit(1);
  }

  const tokens = await refreshRes.json();
  console.log("  ✓ Refresh OK");
  console.log("    access_token :", mask(tokens.access_token));
  console.log("    expires_in   :", tokens.expires_in, "s");
  const rotated = tokens.refresh_token && tokens.refresh_token !== refreshToken;
  console.log(
    "    refresh_token:",
    rotated ? `ROTATED -> ${mask(tokens.refresh_token)} (old one now dead)` : "unchanged this call"
  );

  // Persist the rotated token immediately so it is never lost, even if the
  // Messages step below fails (the old token is already dead at this point).
  if (rotated && source.file) {
    persistRotatedToken(source, tokens.refresh_token);
    console.log(`    (wrote rotated token back to ${source.file} as ${source.key})`);
  } else if (rotated) {
    console.log("    new_refresh_token:");
    console.log(tokens.refresh_token);
    console.log("    Save this value now; the previous refresh token is already invalid.");
  }

  // --- Step 2: access token -> Messages API ---
  console.log("\n[2/2] Calling Messages API (model:", MODEL + ") …");
  const msgRes = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "anthropic-beta": BETA,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with exactly: it works" }],
    }),
  });

  if (!msgRes.ok) {
    const body = await msgRes.text();
    console.error(`  ✗ Messages call failed: ${msgRes.status}`);
    console.error("  Body:", body.slice(0, 400));
    // Surface rate-limit / retry metadata so we know the reset window.
    const interesting = [
      "retry-after",
      "anthropic-ratelimit-unified-reset",
      "anthropic-ratelimit-unified-status",
      "anthropic-ratelimit-requests-reset",
      "anthropic-ratelimit-tokens-reset",
    ];
    const seen = interesting.filter((h) => msgRes.headers.get(h) !== null);
    if (seen.length) {
      console.error("  Rate-limit headers:");
      for (const h of seen) console.error(`    ${h}: ${msgRes.headers.get(h)}`);
    } else {
      console.error("  (no retry-after / anthropic-ratelimit-* headers present)");
    }
    if (msgRes.status === 429) {
      console.error(
        "\n  429 = rate-limited, NOT an auth failure (the request authenticated and returned a request_id).\n" +
          "  The subscription's shared usage bucket is likely exhausted; retry after the reset above."
      );
    } else {
      console.error(
        "\n  (A 401/403 here while step 1 passed points at the access-token/header path, e.g. a missing scope.)"
      );
    }
    process.exit(1);
  }

  const data = await msgRes.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  console.log("  ✓ Messages OK");
  console.log("    model reply :", JSON.stringify(text));
  console.log("    usage       :", JSON.stringify(data.usage));

  console.log("\n✅ End-to-end OK — refresh + subscription inference both work.");
  if (rotated) {
    console.log(
      source.file
        ? `ℹ️  The refresh token rotated and the live value was saved to ${source.file}. ` +
            "Paste THAT value into Open-Inspect Secrets (the previous one is now dead)."
        : "⚠️  The refresh token rotated; the previous value is now dead. The live value was printed above."
    );
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e.message);
  process.exit(1);
});
