#!/usr/bin/env node
// claude-oauth-login.mjs
//
// Captures a Claude (Anthropic) OAuth refresh token for internal team use.
//
// This runs the Claude OAuth 2.0 Authorization-Code-with-PKCE flow against a
// Claude Pro/Max subscription account. The resulting refresh token lets
// Open-Inspect drive the Anthropic Messages API on the team's subscription
// instead of a metered API key. Paste the printed refresh token into
// Open-Inspect Settings > Secrets as ANTHROPIC_OAUTH_REFRESH_TOKEN.
//
// No external dependencies: uses node:crypto, node:readline/promises, and the
// global fetch. Run with: node scripts/claude-oauth-login.mjs

import { randomBytes, createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// Verified Claude OAuth constants (public PKCE client — no secret).
const AUTHORIZE_ENDPOINT = "https://claude.ai/oauth/authorize";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

/** base64url-encode a Buffer without padding. */
function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE verifier (random 32 bytes, base64url) and its S256 challenge. */
function createPkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Build the Claude authorize URL for the PKCE flow. */
function buildAuthorizeUrl({ challenge, state }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange the authorization code for tokens.
 * The callback page may render the value as `code#state`; split on '#' and use
 * the embedded state if present so it matches the value we generated.
 */
async function exchangeCodeForTokens({ pastedCode, verifier, state }) {
  const [code, returnedState] = pastedCode.split("#");

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: returnedState ?? state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${detail}`);
  }

  return response.json();
}

async function main() {
  console.log("=== Claude (Anthropic) OAuth login ===");
  console.log("Captures a Claude Pro/Max subscription refresh token for internal team use.\n");

  const { verifier, challenge } = createPkcePair();
  // The verifier doubles as the state value, matching the Claude Code PKCE flow.
  const state = verifier;

  const authorizeUrl = buildAuthorizeUrl({ challenge, state });

  console.log("1. Open this URL in your browser and approve the request:\n");
  console.log(`   ${authorizeUrl}\n`);
  console.log("2. After approving, the callback page shows an authorization code.");
  console.log("   It may look like `code#state` — paste it exactly as shown.\n");

  const rl = createInterface({ input: stdin, output: stdout });
  let tokens;
  try {
    const pastedCode = (await rl.question("Paste the authorization code: ")).trim();
    if (!pastedCode) {
      throw new Error("No code provided.");
    }
    tokens = await exchangeCodeForTokens({ pastedCode, verifier, state });
  } finally {
    rl.close();
  }

  const expiresAtMs = Date.now() + tokens.expires_in * 1000;

  console.log("\n=== Success ===\n");
  console.log("Refresh token (paste this into Open-Inspect Settings > Secrets as");
  console.log("ANTHROPIC_OAUTH_REFRESH_TOKEN):\n");
  console.log(`   ${tokens.refresh_token}\n`);
  console.log("For reference (these refresh automatically; you do not need to store them):");
  console.log(`   access token : ${tokens.access_token}`);
  console.log(`   expires at   : ${new Date(expiresAtMs).toISOString()} (${expiresAtMs} ms)`);
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
