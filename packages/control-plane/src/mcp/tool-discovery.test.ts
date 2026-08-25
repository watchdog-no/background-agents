import type { FetchLike } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { describe, expect, it, vi } from "vitest";
import { discoverRemoteMcpTools } from "./tool-discovery";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const remoteServer: McpServerConfig = {
  id: "mcp-1",
  name: "remote",
  type: "remote",
  url: "https://mcp.example.com/api",
  headers: { Authorization: "Bearer secret", "X-Tenant": "watchdog" },
  repoScopes: null,
  toolAllowlist: null,
  enabled: true,
};

describe("discoverRemoteMcpTools", () => {
  it("discovers, sanitizes, deduplicates, and sorts remote tools", async () => {
    const requestHeaders: Headers[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));

      if (init?.method === "GET") return new Response(null, { status: 405 });
      const message = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };

      if (message.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "test-server", version: "1.0.0" },
          },
        });
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              { name: " zebra ", description: "  Last tool  ", inputSchema: { type: "object" } },
              { name: "alpha", description: "First tool", inputSchema: { type: "object" } },
              { name: "alpha", description: "Duplicate", inputSchema: { type: "object" } },
              { name: "   ", inputSchema: { type: "object" } },
            ],
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${message.method}`);
    });

    const tools = await discoverRemoteMcpTools(remoteServer, fetchMock as FetchLike);

    expect(tools).toEqual([
      { name: "alpha", description: "First tool" },
      { name: "zebra", description: "Last tool" },
    ]);
    expect(requestHeaders).not.toHaveLength(0);
    for (const headers of requestHeaders) {
      expect(headers.get("authorization")).toBe("Bearer secret");
      expect(headers.get("x-tenant")).toBe("watchdog");
    }
  });

  it("rejects local servers without making a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      discoverRemoteMcpTools(
        {
          ...remoteServer,
          type: "local",
          url: undefined,
          command: ["npx", "server"],
        },
        fetchMock as FetchLike
      )
    ).rejects.toThrow(/remote MCP servers only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
