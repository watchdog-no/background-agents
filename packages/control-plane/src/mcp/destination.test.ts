import { describe, expect, it } from "vitest";
import { mcpDestination, mcpDestinationInRegistrableDomain } from "./destination";

describe("mcpDestination", () => {
  it("accepts a public HTTPS endpoint", () => {
    expect(mcpDestination("https://mcp.example.com/mcp").origin).toBe("https://mcp.example.com");
    expect(mcpDestination("https://MCP.example.com:443/mcp").origin).toBe(
      "https://mcp.example.com"
    );
  });

  it.each([
    "http://mcp.example.com/mcp",
    "https://203.0.113.7/mcp",
    "https://[2001:db8::1]/mcp",
    "https://localhost/mcp",
    "https://mcp.internal/mcp",
    "https://service.local/mcp",
    "https://intranet/mcp",
    "https://mcp.example.com./mcp",
    "https://user:secret@mcp.example.com/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://mcp.example.com/mcp#fragment",
    "not a url",
  ])("rejects %s", (value) => {
    expect(() => mcpDestination(value)).toThrow(
      expect.objectContaining({ code: "mcp_unsupported" })
    );
  });

  it("requires the expected origin when one is given", () => {
    expect(() =>
      mcpDestination("https://tokens.example.net/token", "https://auth.example.com")
    ).toThrow(expect.objectContaining({ code: "mcp_unsupported" }));
    expect(
      mcpDestination("https://auth.example.com/token", "https://auth.example.com").pathname
    ).toBe("/token");
  });
});

describe("mcpDestinationInRegistrableDomain", () => {
  const anchor = new URL("https://api.foo.test");

  it("accepts other hosts on the same registrable domain", () => {
    expect(
      mcpDestinationInRegistrableDomain("https://foo.test/oauth/authorize", anchor).origin
    ).toBe("https://foo.test");
    expect(mcpDestinationInRegistrableDomain("https://auth.foo.test/a", anchor).origin).toBe(
      "https://auth.foo.test"
    );
  });

  it.each([
    "https://foo.test.evil.example/a",
    "https://evilfoo.test/a",
    "https://foo.example/a",
    "http://foo.test/a",
    "https://foo.test:8443/a",
    "https://user:pw@foo.test/a",
  ])("rejects %s", (value) => {
    expect(() => mcpDestinationInRegistrableDomain(value, anchor)).toThrow(
      expect.objectContaining({ code: "mcp_unsupported" })
    );
  });

  it("treats private suffixes as public suffixes", () => {
    const tenant = new URL("https://a.github.io");
    expect(() => mcpDestinationInRegistrableDomain("https://b.github.io/x", tenant)).toThrow(
      expect.objectContaining({ code: "mcp_unsupported" })
    );
    expect(mcpDestinationInRegistrableDomain("https://www.a.github.io/x", tenant).origin).toBe(
      "https://www.a.github.io"
    );
  });
});
