// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { McpServersSettings } from "./mcp-servers-settings";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  updateMcpServer: vi.fn(),
  discoverMcpTools: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));
vi.mock("@/hooks/use-mcp-servers", () => ({
  useMcpServers: () => ({ servers, loading: false, mutate: mocks.mutate }),
  createMcpServer: vi.fn(),
  updateMcpServer: mocks.updateMcpServer,
  deleteMcpServer: vi.fn(),
  discoverMcpTools: mocks.discoverMcpTools,
}));

const servers: McpServerMetadata[] = [
  {
    id: "server-a",
    revision: 3,
    name: "Server A",
    type: "remote",
    url: "https://a.example.com",
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    toolAllowlist: null,
    enabled: true,
  },
  {
    id: "server-b",
    revision: 7,
    name: "Server B",
    type: "remote",
    url: "https://b.example.com",
    hasEnv: false,
    hasHeaders: false,
    repoScopes: null,
    toolAllowlist: ["query"],
    enabled: true,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.discoverMcpTools.mockResolvedValue([
    { name: "errors", description: "List error groups" },
    { name: "query", description: "Query telemetry" },
  ]);
});

describe("McpServersSettings", () => {
  it("does not close a newer draft when an older save completes", async () => {
    let resolveSave!: (server: McpServerMetadata) => void;
    mocks.updateMcpServer.mockReturnValue(
      new Promise<McpServerMetadata>((resolve) => {
        resolveSave = resolve;
      })
    );
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-a",
      expect.objectContaining({ revision: 3 })
    );

    await user.click(screen.getByRole("button", { name: /Server B/ }));
    expect(screen.getByDisplayValue("https://b.example.com")).toBeInTheDocument();

    resolveSave({ ...servers[0], revision: 4 });

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    expect(screen.getByDisplayValue("https://b.example.com")).toBeInTheDocument();
  });

  it("does not reinterpret entered credentials when the server type changes", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[0], type: "local", revision: 4 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.type(screen.getByPlaceholderText("Header-Name"), "Authorization");
    await user.type(screen.getByPlaceholderText("value"), "secret");
    await user.click(screen.getByRole("button", { name: "Local" }));
    await user.type(screen.getByPlaceholderText("npx -y @playwright/mcp"), "npx tool");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith("server-a", {
      name: "Server A",
      enabled: true,
      repoScopes: null,
      toolAllowlist: null,
      type: "local",
      command: ["npx", "tool"],
      revision: 3,
    });
  });

  it("loads remote tools, filters them, and preserves explicit selections", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[1], revision: 8 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server B/ }));

    await waitFor(() => expect(mocks.discoverMcpTools).toHaveBeenCalledWith("server-b"));
    expect(await screen.findByText("1 selected / 2 available")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /query/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /errors/i })).not.toBeChecked();

    await user.type(screen.getByPlaceholderText("Search tools"), "error");
    expect(screen.getByText("errors")).toBeInTheDocument();
    expect(screen.queryByText("query")).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /errors/i }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-b",
      expect.objectContaining({ toolAllowlist: ["errors", "query"], revision: 7 })
    );
  });

  it("selects every tool on first discovery and leaves future tools unchecked", async () => {
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    expect(await screen.findByText("2 selected / 2 available")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /errors/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /query/i })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: /errors/i }));
    mocks.discoverMcpTools.mockResolvedValue([
      { name: "errors", description: "List error groups" },
      { name: "query", description: "Query telemetry" },
      { name: "new_tool", description: "A newly advertised tool" },
    ]);
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("1 selected / 3 available")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /query/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /new_tool/i })).not.toBeChecked();
  });

  it("accepts manual tool names for local servers", async () => {
    mocks.updateMcpServer.mockResolvedValue({ ...servers[0], type: "local", revision: 4 });
    const user = userEvent.setup();
    render(<McpServersSettings />);

    await user.click(screen.getByRole("button", { name: /Server A/ }));
    await user.click(screen.getByRole("button", { name: "Local" }));
    await user.type(screen.getByPlaceholderText("npx -y @playwright/mcp"), "npx tool");
    await user.click(screen.getByText("Selected tools only"));
    await user.type(
      screen.getByPlaceholderText("Add a tool name and press Enter"),
      "query,errors{Enter}"
    );
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mocks.updateMcpServer).toHaveBeenCalled());
    expect(mocks.updateMcpServer).toHaveBeenCalledWith(
      "server-a",
      expect.objectContaining({ toolAllowlist: ["query", "errors"], revision: 3 })
    );
  });
});
