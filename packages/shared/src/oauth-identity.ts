/**
 * Constants for calling provider APIs with subscription OAuth access tokens.
 *
 * Anthropic Pro/Max OAuth tokens are only authorized for Claude Code requests:
 * the first system block must be the Claude Code identity, and the request must
 * carry the OAuth beta header. Otherwise Anthropic rejects the call (often as a
 * misleading 429 with no rate-limit headers). The sandbox auth plugin enforces
 * the same contract for the coding agent; these constants let the control-plane
 * classifier do likewise.
 */

/** Required first system block when authenticating to Anthropic via OAuth. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** `anthropic-beta` header value that enables OAuth token auth. */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
