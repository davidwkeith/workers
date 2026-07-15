import { describe, expect, it } from "vitest";

import { buildProtectedResourceMetadata } from "./metadata.js";

describe("buildProtectedResourceMetadata", () => {
  it("builds the required RFC 9728 members", () => {
    const doc = buildProtectedResourceMetadata({
      resource: "https://example.com/mcp",
      authorizationServers: ["https://example.com/"],
    });
    expect(doc).toEqual({
      resource: "https://example.com/mcp",
      authorization_servers: ["https://example.com/"],
      bearer_methods_supported: ["DPoP"],
    });
  });

  it("always advertises DPoP-only, never plain bearer", () => {
    const doc = buildProtectedResourceMetadata({
      resource: "https://example.com/mcp",
      authorizationServers: ["https://example.com/"],
    });
    expect(doc.bearer_methods_supported).toEqual(["DPoP"]);
  });

  it("includes scopes_supported and resource_documentation when provided", () => {
    const doc = buildProtectedResourceMetadata({
      resource: "https://example.com/mcp",
      authorizationServers: ["https://example.com/"],
      scopesSupported: ["create", "microsub:read"],
      resourceDocumentation: "https://example.com/docs/mcp",
    });
    expect(doc.scopes_supported).toEqual(["create", "microsub:read"]);
    expect(doc.resource_documentation).toBe("https://example.com/docs/mcp");
  });

  it("omits scopes_supported and resource_documentation when absent", () => {
    const doc = buildProtectedResourceMetadata({
      resource: "https://example.com/mcp",
      authorizationServers: ["https://example.com/"],
    });
    expect(doc).not.toHaveProperty("scopes_supported");
    expect(doc).not.toHaveProperty("resource_documentation");
  });
});
