import { settingsProxy } from "@/lib/settings-proxy";

export const { POST } = settingsProxy<{ id: string }>(
  ({ id }) => `/mcp-servers/${encodeURIComponent(id)}/tools`,
  "MCP tools"
);
