/**
 * Constants for calling provider APIs with subscription OAuth access tokens.
 *
 * Anthropic Pro/Max OAuth tokens route through subscription capacity only when
 * the request carries the Claude Code SDK transport envelope. The sandbox auth
 * plugin enforces the same contract for the coding agent; these constants let
 * the control-plane classifier do likewise.
 */

/** Legacy identity retained for compatibility with earlier request-shape tests. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export const CLAUDE_CODE_CLIENT_VERSION = "2.1.162";

export const CLAUDE_CODE_MAX_TOKENS = 64000;

export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_CLIENT_VERSION} (external, sdk-cli)`;

export const CLAUDE_CODE_BILLING_HEADER =
  `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_CLIENT_VERSION}.518; ` +
  "cc_entrypoint=sdk-cli; cch=00000;";

export const CLAUDE_CODE_AGENT_SDK_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export const ANTHROPIC_CLAUDE_CODE_OAUTH_BETA_VALUES = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
] as const;

/** `anthropic-beta` header value that enables Claude Code OAuth token auth. */
export const ANTHROPIC_OAUTH_BETA = ANTHROPIC_CLAUDE_CODE_OAUTH_BETA_VALUES.join(", ");
