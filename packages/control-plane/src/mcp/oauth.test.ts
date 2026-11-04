import { describe, expect, it } from "vitest";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import type { McpConnectionStore } from "../db/mcp-connections";
import { McpOAuthService } from "./oauth";

const ORIGIN = "https://api.example.com";
const RESOURCE = `${ORIGIN}/v4/mcp`;
const ROOT_PATH = "/.well-known/oauth-protected-resource";
const REDIRECT = "https://app.example.com/callback";

const server = {
  id: "srv",
  url: RESOURCE,
  enabled: true,
  authMode: "user_oauth",
  managedRouting: true,
  authRevision: 1,
  oauth: { issuer: ORIGIN, resource: RESOURCE },
} as unknown as McpServerMetadata;

function setup(protectedPaths: Record<string, number | undefined>) {
  const requested: string[] = [];
  const store = {
    getClient: async () => null,
    saveClient: async () => {},
  } as unknown as McpConnectionStore;
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    requested.push(url.pathname);
    if (url.pathname.startsWith(ROOT_PATH)) {
      const status = protectedPaths[url.pathname];
      if (status === undefined) return new Response("not found", { status: 404 });
      if (status !== 200) return new Response("error", { status });
      return Response.json({ resource: RESOURCE, authorization_servers: [ORIGIN] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register") {
      return Response.json({
        client_id: "client",
        token_endpoint_auth_method: "none",
        redirect_uris: [REDIRECT],
      });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { service: new McpOAuthService(store, fetcher), requested };
}

describe("McpOAuthService protected resource discovery", () => {
  it("uses the path-inserted well-known URL when present", async () => {
    const { service, requested } = setup({ [`${ROOT_PATH}/v4/mcp`]: 200 });
    await service.client(server, REDIRECT);
    expect(requested).toContain(`${ROOT_PATH}/v4/mcp`);
    expect(requested).not.toContain(ROOT_PATH);
  });

  it("falls back to the origin-root well-known URL", async () => {
    const { service, requested } = setup({ [ROOT_PATH]: 200 });
    await expect(service.client(server, REDIRECT)).resolves.toMatchObject({ client_id: "client" });
    expect(requested.slice(0, 2)).toEqual([`${ROOT_PATH}/v4/mcp`, ROOT_PATH]);
  });

  it("fails when neither location publishes metadata", async () => {
    const { service } = setup({});
    await expect(service.client(server, REDIRECT)).rejects.toMatchObject({
      code: "mcp_reconnect_required",
    });
  });

  it("still rejects root metadata naming a different resource", async () => {
    const { service } = setup({ [ROOT_PATH]: 200 });
    const other = {
      ...server,
      url: `${ORIGIN}/other`,
      oauth: { issuer: ORIGIN, resource: `${ORIGIN}/other` },
    } as unknown as McpServerMetadata;
    await expect(service.client(other, REDIRECT)).rejects.toMatchObject({ code: "mcp_denied" });
  });
});
