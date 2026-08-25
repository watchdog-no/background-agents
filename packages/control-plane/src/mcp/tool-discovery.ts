import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
  type Transport,
} from "@modelcontextprotocol/client";
import type { McpServerConfig, McpToolMetadata } from "@open-inspect/shared/types/integrations";

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_DISCOVERED_TOOLS = 1000;
const MAX_TOOL_DESCRIPTION_LENGTH = 2000;

function authenticatedFetch(
  headers: Record<string, string>,
  signal: AbortSignal,
  baseFetch: FetchLike
): FetchLike {
  return (input, init) => {
    const requestHeaders = new Headers(headers);
    for (const [name, value] of new Headers(init?.headers)) requestHeaders.set(name, value);
    return baseFetch(input, { ...init, headers: requestHeaders, signal });
  };
}

async function listTools(transport: Transport): Promise<McpToolMetadata[]> {
  const client = new Client(
    { name: "open-inspect-settings", version: "1.0.0" },
    { listMaxPages: 64 }
  );
  try {
    await client.connect(transport);
    const result = await client.listTools();
    if (result.tools.length > MAX_DISCOVERED_TOOLS) {
      throw new Error(`MCP server advertised more than ${MAX_DISCOVERED_TOOLS} tools`);
    }

    const tools = new Map<string, McpToolMetadata>();
    for (const tool of result.tools) {
      const name = tool.name.trim();
      if (!name || tools.has(name)) continue;
      const description = tool.description?.trim().slice(0, MAX_TOOL_DESCRIPTION_LENGTH);
      tools.set(name, description ? { name, description } : { name });
    }
    return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function discoverRemoteMcpTools(
  server: McpServerConfig,
  baseFetch: FetchLike = fetch
): Promise<McpToolMetadata[]> {
  if (server.type !== "remote" || !server.url) {
    throw new Error("Tool discovery is currently supported for remote MCP servers only");
  }

  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Remote MCP server URL must use HTTP or HTTPS");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  const request = authenticatedFetch(server.headers ?? {}, controller.signal, baseFetch);

  try {
    try {
      return await listTools(new StreamableHTTPClientTransport(url, { fetch: request }));
    } catch (streamableError) {
      if (controller.signal.aborted) throw streamableError;
      return await listTools(new SSEClientTransport(url, { fetch: request }));
    }
  } finally {
    clearTimeout(timeout);
  }
}
