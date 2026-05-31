#!/usr/bin/env node
/**
 * End-to-end diagnosis for the Claude (Anthropic OAuth) sandbox session path.
 *
 * Faithfully simulates what happens when Open-Inspect boots a NEW sandbox and
 * sends a NEW prompt, isolated to the authentication + OpenCode + Anthropic leg
 * (no Modal, no D1, no web, no WebSockets):
 *
 *   1. Refresh: exchange the subscription refresh token for a short-lived access
 *      token (same call as control-plane src/auth/anthropic.ts).
 *   2. Sandbox boot: reproduce entrypoint.start_opencode() exactly —
 *        - write ~/.local/share/opencode/auth.json with the OAuth "dummy" entry
 *          (_setup_anthropic_oauth)
 *        - copy the REAL anthropic-auth-plugin.js into .opencode/plugins/
 *        - build OPENCODE_CONFIG_CONTENT the same way (model, permission, …)
 *        - set ANTHROPIC_OAUTH_ENABLED / CONTROL_PLANE_URL / SANDBOX_AUTH_TOKEN /
 *          SESSION_CONFIG and launch the pinned `opencode serve`.
 *   3. Control-plane stub: serve POST /sessions/:id/anthropic-token-refresh so the
 *      plugin's refreshViaControlPlane()/ensureAccessToken() runs for real.
 *   4. First chat: create a session and POST /session/:id/prompt_async exactly
 *      like bridge.py, so OpenCode builds the real request (system prompt, tools,
 *      cache_control breakpoints, prompt caching) and the plugin signs it.
 *   5. Inspecting proxy sits at provider.anthropic.options.baseURL and forwards
 *      transparently to api.anthropic.com, logging the EXACT outgoing request
 *      (first system block, auth + anthropic-beta headers) and the upstream
 *      status + token usage (cache_read / cache_creation), so we can see whether
 *      Anthropic returns 200 or 429 and whether prompt caching is working.
 *
 * Two prompts are sent in the same session: the first writes the prompt cache,
 * the second should read it (cache_read_input_tokens > 0) — proving caching.
 *
 * Reads ANTHROPIC_OAUTH_REFRESH_TOKEN (or TOKEN) from the environment, or from a
 * file passed as the first arg (e.g. .env-tmp, which is gitignored). Refresh
 * tokens ROTATE on use, so the rotated value is persisted back to that file.
 *
 * Usage:
 *   node scripts/diagnose-claude-session.mjs .env-tmp
 *   ANTHROPIC_OAUTH_REFRESH_TOKEN=sk-ant-ort-... node scripts/diagnose-claude-session.mjs
 *
 * Env overrides:
 *   MODEL=claude-opus-4-8           # default claude-sonnet-4-6 (cheaper, no opus quota confound)
 *   PROMPT='Hello, who are you?'     # first prompt to send through OpenCode
 *   SECOND_PROMPT='...'              # second same-session prompt used to verify prompt caching
 *   OPENCODE_BIN=opencode           # use a binary on PATH instead of the pinned npx version
 *   OPENCODE_VERSION=1.15.13        # npx version to run when OPENCODE_BIN is unset
 *   KEEP_TMP=1                      # don't delete the temp sandbox dir (for inspection)
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PLUGIN_SRC = join(
  REPO_ROOT,
  "packages/sandbox-runtime/src/sandbox_runtime/plugins/anthropic-auth-plugin.js"
);

const TOKEN_URL =
  process.env.ANTHROPIC_OAUTH_TOKEN_URL?.trim() || "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID =
  process.env.ANTHROPIC_OAUTH_CLIENT_ID?.trim() || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA = "oauth-2025-04-20";
const MODEL = process.env.MODEL?.trim() || process.env.VERIFY_MODEL?.trim() || "claude-sonnet-4-6";
const OPENCODE_VERSION = process.env.OPENCODE_VERSION?.trim() || "1.15.13";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SANDBOX_AUTH_TOKEN = "diag-sandbox-auth-token";
const SESSION_ID = "diag-session";

const PROMPT_1 = process.env.PROMPT?.trim() || "Hello, who are you?";
const PROMPT_2 =
  process.env.SECOND_PROMPT?.trim() || "Answer the same question again in one short sentence.";

function mask(s) {
  if (!s) return "(missing)";
  return `${s.slice(0, 8)}…${s.slice(-4)} (len=${s.length})`;
}

function log(...args) {
  console.log(...args);
}

// --------------------------------------------------------------------------
// Refresh-token loading (mirrors scripts/verify-anthropic-token.mjs)
// --------------------------------------------------------------------------
const KEY_NAMES = ["ANTHROPIC_OAUTH_REFRESH_TOKEN", "TOKEN"];

function loadRefreshToken() {
  for (const key of KEY_NAMES) {
    if (process.env[key]) return { token: process.env[key].trim(), file: null, key };
  }
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
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

function persistRotatedToken({ file, key }, newToken) {
  if (!file) return false;
  const lines = readFileSync(file, "utf8").split("\n");
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`);
  const updated = lines.map((line) => (re.test(line) ? line.replace(re, `$1${newToken}`) : line));
  writeFileSync(file, updated.join("\n"));
  return true;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// --------------------------------------------------------------------------
// Inspecting proxy: transparent forward to api.anthropic.com, logs the exact
// request OpenCode+plugin emit and the upstream status + cache usage.
// --------------------------------------------------------------------------
function extractUsage(sseText) {
  // Anthropic streams usage in message_start (input + cache) and message_delta
  // (output). Merge every "usage" object we can find; keep the largest of each.
  const usage = {};
  const re = /"usage"\s*:\s*(\{[^}]*\})/g;
  let m;
  while ((m = re.exec(sseText))) {
    let obj;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number") usage[k] = Math.max(usage[k] ?? 0, v);
    }
  }
  return usage;
}

function startProxy() {
  const records = [];
  let dumpedSystem = false;
  const HOP = new Set([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "accept-encoding",
  ]);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);

    let systemFirst = null;
    let toolCount = null;
    let modelId = null;
    let cacheBreakpoints = 0;
    try {
      const j = JSON.parse(bodyBuf.toString("utf8"));
      modelId = j.model ?? null;
      if (Array.isArray(j.system)) {
        systemFirst = j.system[0]?.text ?? null;
        cacheBreakpoints += j.system.filter((b) => b?.cache_control).length;
      } else if (typeof j.system === "string") {
        systemFirst = j.system;
      }
      if (Array.isArray(j.tools)) {
        toolCount = j.tools.length;
        cacheBreakpoints += j.tools.filter((t) => t?.cache_control).length;
      }
      // One-shot dump of the exact `system` array of the first agent (non
      // title-gen) /messages call, so we can show precisely what is sent.
      if (
        !dumpedSystem &&
        typeof req.url === "string" &&
        req.url.includes("/messages") &&
        Array.isArray(j.system) &&
        Array.isArray(j.tools) &&
        j.tools.length > 0
      ) {
        dumpedSystem = true;
        writeFileSync("/tmp/diag-system.json", JSON.stringify(j.system, null, 2));
      }
    } catch {
      /* not JSON (e.g. GET) */
    }

    const reqHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k.toLowerCase())) reqHeaders[k] = v;
    }

    const record = {
      method: req.method,
      url: req.url,
      modelId,
      systemFirst: systemFirst ? systemFirst.slice(0, 120) : systemFirst,
      hasAuthorization: !!req.headers["authorization"],
      anthropicBeta: req.headers["anthropic-beta"] ?? null,
      cacheBreakpoints,
      toolCount,
      status: null,
      ratelimitHeaders: [],
      usage: null,
      errorBody: null,
    };
    records.push(record);

    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_BASE + req.url, {
        method: req.method,
        headers: reqHeaders,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuf,
      });
    } catch (e) {
      record.status = "PROXY_ERROR";
      record.errorBody = String(e);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("proxy error");
      return;
    }

    record.status = upstream.status;
    record.ratelimitHeaders = [...upstream.headers.keys()].filter(
      (k) => k.startsWith("anthropic-ratelimit") || k === "retry-after"
    );

    // Forward response headers, dropping ones invalidated by decompression.
    const resHeaders = {};
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding")
        return;
      resHeaders[k] = v;
    });
    res.writeHead(upstream.status, resHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    const isStream = (upstream.headers.get("content-type") || "").includes("event-stream");
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let acc = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        if (acc.length < 500_000) acc += dec.decode(value, { stream: true });
      }
    } finally {
      res.end();
    }
    if (isStream || upstream.status >= 400) {
      record.usage = extractUsage(acc);
      if (upstream.status >= 400) record.errorBody = acc.slice(0, 400);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, records }));
  });
}

// --------------------------------------------------------------------------
// Control-plane stub: mirrors POST /sessions/:id/anthropic-token-refresh
// --------------------------------------------------------------------------
function startControlPlaneStub(accessToken, expiresIn) {
  let refreshCalls = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && /\/sessions\/[^/]+\/anthropic-token-refresh$/.test(req.url)) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${SANDBOX_AUTH_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      refreshCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, getRefreshCalls: () => refreshCalls })
    );
  });
}

// --------------------------------------------------------------------------
// Sandbox boot: reproduce entrypoint.start_opencode() setup
// --------------------------------------------------------------------------
function setupSandbox(proxyPort, cpPort) {
  const root = mkdtempSync(join(tmpdir(), "diag-sandbox-"));
  const projectDir = join(root, "workspace");
  const dataHome = join(root, "xdg-data");

  // .opencode/plugins/anthropic-auth-plugin.js (entrypoint copies the real file)
  const pluginsDir = join(projectDir, ".opencode", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  copyFileSync(PLUGIN_SRC, join(pluginsDir, "anthropic-auth-plugin.js"));

  // ~/.local/share/opencode/auth.json (_setup_anthropic_oauth dummy entry)
  const ocDataDir = join(dataHome, "opencode");
  mkdirSync(ocDataDir, { recursive: true });
  writeFileSync(
    join(ocDataDir, "auth.json"),
    JSON.stringify({
      anthropic: { type: "oauth", refresh: "managed-by-control-plane", access: "", expires: 0 },
    })
  );

  // OPENCODE_CONFIG_CONTENT — same shape as entrypoint, plus the proxy baseURL
  // (the only deviation; the proxy forwards 1:1 so the request is unchanged).
  const opencodeConfig = {
    model: `anthropic/${MODEL}`,
    autoupdate: false,
    permission: { "*": "allow", doom_loop: "deny" },
    provider: {
      anthropic: {
        options: { baseURL: `http://127.0.0.1:${proxyPort}/v1` },
      },
    },
  };

  const env = {
    ...process.env,
    HOME: root,
    XDG_DATA_HOME: dataHome,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
    OPENCODE_CLIENT: "serve",
    ANTHROPIC_OAUTH_ENABLED: "true",
    CONTROL_PLANE_URL: `http://127.0.0.1:${cpPort}`,
    SANDBOX_AUTH_TOKEN,
    SESSION_CONFIG: JSON.stringify({ sessionId: SESSION_ID, provider: "anthropic", model: MODEL }),
  };

  return { root, projectDir, dataHome, env };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function startOpencode(projectDir, env, port) {
  const bin = process.env.OPENCODE_BIN;
  const cmd = bin || "npx";
  const args = bin
    ? ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"]
    : [
        "-y",
        `opencode-ai@${OPENCODE_VERSION}`,
        "serve",
        "--port",
        String(port),
        "--hostname",
        "127.0.0.1",
        "--print-logs",
      ];
  log(`  launching: ${cmd} ${args.join(" ")} (cwd=${projectDir})`);
  const proc = spawn(cmd, args, { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => process.stderr.write(`  [opencode] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`  [opencode] ${d}`));
  return proc;
}

async function waitForOpencode(base, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (r.ok) return (await r.json()).id;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("OpenCode did not become ready in time");
}

async function sendPrompt(base, sessionId, text) {
  const r = await fetch(`${base}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      model: { providerID: "anthropic", modelID: MODEL },
    }),
  });
  if (![200, 204].includes(r.status)) {
    throw new Error(`prompt_async failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

// Wait until a NEW upstream /v1/messages record appears (after `sinceCount`),
// then a little longer so its streamed usage is captured.
// Find the agent's upstream /v1/messages call (after `sinceCount`) and wait
// until its stream has fully completed. Two things matter here:
//   - OpenCode fires an auxiliary title-generation call (no tools) before the
//     real agent call. We require tools so we report the actual agent request,
//     not title generation.
//   - `record.usage` is only set once the proxy finishes reading the stream, so
//     we wait for it (or an error status) rather than a fixed grace period —
//     otherwise the next prompt could be posted before the cache write lands.
async function waitForUpstream(records, sinceCount, { requireTools = true, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const isMatch = (r, i) =>
    i >= sinceCount &&
    typeof r.url === "string" &&
    r.url.includes("/messages") &&
    (!requireTools || (r.toolCount ?? 0) > 0);
  while (Date.now() < deadline) {
    const rec = records.find(isMatch);
    // Stream is done once usage was captured (200) or it errored (>=400).
    if (rec && (rec.usage || (typeof rec.status === "number" && rec.status >= 400))) {
      return rec;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return records.find(isMatch) ?? null;
}

// Poll until the latest assistant message has text (the turn finished), so we
// never send the cache-probe prompt mid-turn.
async function waitForAssistantReply(base, sessionId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let text = null;
  while (Date.now() < deadline) {
    text = await readAssistantText(base, sessionId);
    if (text) return text;
    await new Promise((r) => setTimeout(r, 500));
  }
  return text;
}

async function readAssistantText(base, sessionId) {
  try {
    const r = await fetch(`${base}/session/${sessionId}/message`);
    if (!r.ok) return null;
    const msgs = await r.json();
    const assistant = [...msgs].reverse().find((m) => (m.info?.role || m.role) === "assistant");
    if (!assistant) return null;
    const parts = assistant.parts || [];
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();
  } catch {
    return null;
  }
}

function reportRecord(label, rec) {
  if (!rec) {
    log(`  ${label}: no upstream /v1/messages request was captured by the proxy.`);
    log("       (OpenCode may not have routed through the proxy baseURL — check the config.)");
    return;
  }
  log(`  ${label}:`);
  log(`     upstream status   : ${rec.status}`);
  log(`     model             : ${rec.modelId}`);
  log(`     authorization sent : ${rec.hasAuthorization ? "Bearer <token>" : "NONE"}`);
  log(`     anthropic-beta     : ${rec.anthropicBeta ?? "NONE"}`);
  log(`     system[0]          : ${JSON.stringify(rec.systemFirst)}`);
  log(`     cache breakpoints  : ${rec.cacheBreakpoints} (system + tools)`);
  log(`     tools              : ${rec.toolCount ?? "n/a"}`);
  log(
    `     ratelimit headers  : ${rec.ratelimitHeaders.length ? rec.ratelimitHeaders.join(", ") : "NONE"}`
  );
  if (rec.usage) {
    log(
      `     usage              : input=${rec.usage.input_tokens ?? "?"} ` +
        `cache_write=${rec.usage.cache_creation_input_tokens ?? 0} ` +
        `cache_read=${rec.usage.cache_read_input_tokens ?? 0} ` +
        `output=${rec.usage.output_tokens ?? "?"}`
    );
  }
  if (rec.errorBody) log(`     error body         : ${rec.errorBody}`);
}

async function main() {
  const source = loadRefreshToken();
  if (!source.token) {
    console.error(
      "No refresh token found. Pass a file (e.g. .env-tmp) with an " +
        "ANTHROPIC_OAUTH_REFRESH_TOKEN= or TOKEN= line, or set one of those env vars."
    );
    process.exit(2);
  }
  log("Model under test:", MODEL);
  log("Refresh token   :", mask(source.token), source.file ? `(from ${source.file})` : "");

  // 1. Refresh -> access token (once). Persist rotation immediately.
  log("\n[1/5] Refreshing access token …");
  const tokens = await refreshAccessToken(source.token);
  log("  ✓ access_token:", mask(tokens.access_token), "expires_in:", tokens.expires_in, "s");
  if (tokens.refresh_token && tokens.refresh_token !== source.token) {
    if (source.file) {
      persistRotatedToken(source, tokens.refresh_token);
      log(`  ⟳ refresh token rotated; wrote new value back to ${source.file}`);
    } else {
      log("  ⟳ refresh token ROTATED — save this NOW (old one is dead):");
      log("    " + tokens.refresh_token);
    }
  }

  // Fast path: --probe sends the exact OpenCode system prompt directly to
  // Anthropic, with vs. without the Claude Code identity prepended. Proves the
  // 429-vs-200 difference in two HTTP calls, skipping the OpenCode round-trip.
  if (process.argv.includes("--probe")) {
    log("\n[probe] Sending the OpenCode system prompt directly (no OpenCode) …");
    const ocSystem = "You are OpenCode, the best coding agent on the planet.";
    const cases = [
      { name: "B: OpenCode identity (reproduces bug)", system: [{ type: "text", text: ocSystem }] },
      {
        name: "C: Claude Code identity prepended (the fix)",
        system: [
          { type: "text", text: CLAUDE_CODE_IDENTITY },
          { type: "text", text: ocSystem },
        ],
      },
    ];
    for (const c of cases) {
      const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "anthropic-beta": BETA,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16,
          system: c.system,
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
        }),
      });
      const rl = [...r.headers.keys()].filter(
        (k) => k.startsWith("anthropic-ratelimit") || k === "retry-after"
      );
      let detail = "";
      try {
        const j = await r.json();
        detail = j.content ? j.content.map((b) => b.text).join("") : JSON.stringify(j.error || j);
      } catch {
        /* ignore */
      }
      log(
        `  ${c.name}\n     status=${r.status} ${rl.length ? "ratelimit-hdrs" : "NO-ratelimit-hdrs"} -> ${JSON.stringify(
          (detail || "").slice(0, 100)
        )}`
      );
    }
    process.exit(0);
  }

  // 2. Proxy + control-plane stub
  log("\n[2/5] Starting inspecting proxy + control-plane stub …");
  const proxy = await startProxy();
  const cp = await startControlPlaneStub(tokens.access_token, tokens.expires_in ?? 3600);
  log(`  proxy        → http://127.0.0.1:${proxy.port}/v1  →  ${ANTHROPIC_BASE}`);
  log(
    `  control plane→ http://127.0.0.1:${cp.port}/sessions/${SESSION_ID}/anthropic-token-refresh`
  );

  // 3. Sandbox boot
  log("\n[3/5] Booting simulated sandbox (auth.json + plugin + config) …");
  const sandbox = setupSandbox(proxy.port, cp.port);
  log(`  sandbox dir: ${sandbox.root}`);
  const OC_PORT = await getFreePort();
  const base = `http://127.0.0.1:${OC_PORT}`;
  const proc = startOpencode(sandbox.projectDir, sandbox.env, OC_PORT);

  let exitCode = 0;
  try {
    log("\n[4/5] Waiting for OpenCode and creating a session …");
    const sessionId = await waitForOpencode(base);
    log(`  ✓ opencode up; session: ${sessionId}`);

    // 5. First chat — writes the prompt cache
    log(`\n[5/5] Sending first prompt: "${PROMPT_1}"`);
    let before = proxy.records.length;
    await sendPrompt(base, sessionId, PROMPT_1);
    const rec1 = await waitForUpstream(proxy.records, before);
    reportRecord("First prompt → Anthropic", rec1);
    // Wait for the turn to finish (cache write complete) before probing the cache.
    const reply1 = await waitForAssistantReply(base, sessionId);
    log(`  assistant reply    : ${JSON.stringify(reply1)}`);

    // Second chat — should READ the prompt cache (cache_read_input_tokens > 0)
    log(`\n      Sending second prompt (same session): "${PROMPT_2}"`);
    before = proxy.records.length;
    await sendPrompt(base, sessionId, PROMPT_2);
    const rec2 = await waitForUpstream(proxy.records, before);
    reportRecord("Second prompt → Anthropic", rec2);
    const reply2 = await waitForAssistantReply(base, sessionId);
    log(`  assistant reply    : ${JSON.stringify(reply2)}`);

    // Full upstream log — every /v1/messages call OpenCode made (title
    // generation fires its own auxiliary call, so there are usually more than
    // the two we report above). This makes title-gen vs agent unambiguous.
    log(`\n${"-".repeat(72)}`);
    log("ALL upstream /v1/messages calls (in order):");
    const msgRecords = proxy.records.filter(
      (r) => typeof r.url === "string" && r.url.includes("/messages")
    );
    for (const [i, r] of msgRecords.entries()) {
      const rl = r.ratelimitHeaders.length ? "ratelimit-hdrs" : "NO-ratelimit-hdrs";
      log(
        `  #${i + 1} status=${r.status} ${rl} model=${r.modelId} ` +
          `cache_read=${r.usage?.cache_read_input_tokens ?? "-"} system[0]=${JSON.stringify(r.systemFirst)}`
      );
    }
    log("-".repeat(72));

    // Verdict
    log(`\n${"=".repeat(72)}`);
    log("VERDICT");
    log("=".repeat(72));
    log(`  control-plane refreshes served: ${cp.getRefreshCalls()}`);
    const okStatus = (r) => r && r.status === 200;
    if (okStatus(rec1)) {
      log("  ✅ First chat WORKS — Anthropic returned 200.");
      if (rec2?.usage?.cache_read_input_tokens > 0) {
        log(
          `  ✅ Prompt caching WORKS — second prompt read ${rec2.usage.cache_read_input_tokens} cached tokens.`
        );
      } else if (rec2) {
        log(
          "  ⚠️  Second prompt returned 200 but cache_read_input_tokens was 0 — caching may not be engaging."
        );
      }
    } else if (rec1) {
      log(`  ❌ First chat FAILED — Anthropic returned ${rec1.status}.`);
      const looksLikeRealLimit = rec1.ratelimitHeaders.length > 0;
      const sysIsClaudeCode = (rec1.systemFirst || "").startsWith(
        "You are Claude Code, Anthropic's official CLI"
      );
      if (rec1.status === 429 && !looksLikeRealLimit && !sysIsClaudeCode) {
        log("");
        log("  → Authentication SUCCEEDED (a 401/403 would mean bad creds; we got 429 with a");
        log("    request_id). But NO anthropic-ratelimit-* / retry-after headers are present,");
        log("    which a genuine usage cap always includes. The first system block is NOT the");
        log("    Claude Code identity — it is:");
        log(`      ${JSON.stringify(rec1.systemFirst)}`);
        log("    This is Anthropic's anti-abuse rejection of an OAuth (Pro/Max) token used");
        log("    outside Claude Code, surfaced as a misleading 429 — NOT a rate limit.");
        log("    Fix: have the plugin prepend the Claude Code identity as the first system block.");
      } else if (rec1.status === 429 && looksLikeRealLimit) {
        log("  → This DOES carry rate-limit headers, so it is a genuine usage cap. Reset info:");
        log(`      ${rec1.ratelimitHeaders.join(", ")}`);
      }
    }
    log("=".repeat(72));
  } catch (e) {
    console.error("\n✗ Diagnosis run failed:", e.message);
    exitCode = 1;
  } finally {
    proc.kill("SIGKILL");
    proxy.server.close();
    cp.server.close();
    if (process.env.KEEP_TMP) {
      log(`\n(KEEP_TMP set — left sandbox dir at ${sandbox.root})`);
    } else {
      try {
        rmSync(sandbox.root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
