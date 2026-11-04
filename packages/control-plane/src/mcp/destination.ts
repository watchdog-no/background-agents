import { getDomain } from "tldts";
import { McpError } from "./errors";

/** MVP profile: administrator-registered public HTTPS origins, no redirects or IP targets. */
export function mcpDestination(value: string, expectedOrigin?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError("mcp_unsupported", 400);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    host.endsWith(".") ||
    /(^|\.)(localhost|local|internal|test\.local)$/.test(host) ||
    (expectedOrigin && url.origin !== expectedOrigin)
  ) {
    throw new McpError("mcp_unsupported", 400);
  }
  return url;
}

/**
 * Public HTTPS destination whose registrable domain (eTLD+1, per the Public Suffix List including
 * private suffixes such as `github.io`) matches that of `anchor`. Used for endpoints that are only
 * navigated to by the user's browser, where the issuer's exact origin is not required.
 */
export function mcpDestinationInRegistrableDomain(value: string, anchor: URL): URL {
  const url = mcpDestination(value);
  const expected = getDomain(anchor.hostname, { allowPrivateDomains: true });
  if (!expected || getDomain(url.hostname, { allowPrivateDomains: true }) !== expected) {
    throw new McpError("mcp_unsupported", 400);
  }
  return url;
}
