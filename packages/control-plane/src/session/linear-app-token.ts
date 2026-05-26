import { buildInternalAuthHeaders } from "@open-inspect/shared";
import type { Logger } from "../logger";
import type { Env } from "../types";

/**
 * Deadline for the best-effort Linear app-token fetch during spawn.
 * Injecting the token is optional, so a slow/hung linear-bot (e.g. a stalled
 * OAuth refresh) must not delay session startup. The fetch is aborted past
 * this and treated as a skip.
 */
export const LINEAR_APP_TOKEN_FETCH_TIMEOUT_MS = 3000;

/**
 * Best-effort: set `LINEAR_API_KEY="Bearer <token>"` from the linear-bot's
 * app-actor OAuth token, so `linear-cli` in the sandbox acts as the Linear
 * app rather than a human user.
 *
 * App-actor tokens expire (~24h) and are refreshed server-side by the
 * linear-bot, so they're fetched per spawn rather than stored as a static
 * secret. This is an optional enhancement: if the linear-bot isn't deployed,
 * no workspace has authorized the app, or the fetch fails, the sandbox simply
 * spawns without Linear access. It must not block or fail the spawn.
 */
export async function injectLinearAppToken(
  env: Pick<Env, "LINEAR_BOT" | "INTERNAL_CALLBACK_SECRET">,
  envVars: Record<string, string>,
  log: Logger
): Promise<void> {
  if (!env.LINEAR_BOT || !env.INTERNAL_CALLBACK_SECRET) return;
  // A user-provided key takes precedence over the app-actor identity.
  if (envVars.LINEAR_API_KEY) return;

  try {
    const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);
    const res = await env.LINEAR_BOT.fetch("https://internal/internal/app-token", {
      headers,
      // Bound the fetch so a slow/hung linear-bot can't stall the spawn.
      signal: AbortSignal.timeout(LINEAR_APP_TOKEN_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const data = { status: res.status };
      if (res.status === 404) {
        // 404 = no workspace has completed the OAuth install yet. Not an error.
        log.debug("Linear app token unavailable, skipping injection", data);
      } else {
        log.warn("Linear app token fetch returned non-OK response, skipping injection", data);
      }
      return;
    }
    const { accessToken } = (await res.json()) as { accessToken?: string };
    if (accessToken) {
      envVars.LINEAR_API_KEY = `Bearer ${accessToken}`;
      log.info("Injected Linear app-actor token into sandbox env");
    }
  } catch (err) {
    // Includes the abort timeout — Linear injection is best-effort, never fatal.
    log.warn("Failed to fetch Linear app token", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
