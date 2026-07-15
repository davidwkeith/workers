import { describe, expect, it } from "vitest";
import { McpAuthError } from "./auth.js";
import { JsonRpcErrorCode } from "./jsonrpc.js";
import { createMcp } from "./handler.js";
import type { ToolDefinition } from "./types.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes back its input.",
  inputSchema: { type: "object" },
  requiredScope: "",
  handler: (args) => ({
    content: [{ type: "text", text: String(args.text ?? "") }],
  }),
};

const publishTool: ToolDefinition = {
  name: "publish",
  description: "Publishes a post.",
  inputSchema: { type: "object" },
  requiredScope: "create",
  handler: () => ({ content: [{ type: "text", text: "published" }] }),
};

function post(body: unknown): Request {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createMcp", () => {
  it("rejects GET with 405 and an Allow header", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [],
    });
    const response = await handle(
      new Request("https://example.com/mcp", { method: "GET" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects DELETE with 405 (no session to terminate in this stateless v1)", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [],
    });
    const response = await handle(
      new Request("https://example.com/mcp", { method: "DELETE" }),
    );
    expect(response.status).toBe(405);
  });

  it("returns a JSON-RPC parse error, still HTTP 200, for malformed JSON", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [],
    });
    const response = await handle(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JsonRpcErrorCode.ParseError);
  });

  it("handles a full initialize round trip", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [echoTool],
    });
    const response = await handle(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { protocolVersion: string };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("responds 202 with no body when the whole request was a notification", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [],
    });
    const response = await handle(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("dispatches a batch of requests", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [echoTool],
    });
    const response = await handle(
      post([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    );
    const body = (await response.json()) as unknown[];
    expect(body).toHaveLength(2);
  });

  it("without an authenticate hook, denies a scoped tool call (no scopes granted)", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
    });
    const response = await handle(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "publish", arguments: {} },
      }),
    );
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JsonRpcErrorCode.InsufficientScope);
  });

  it("wires the authenticate hook's granted scopes into the tool call", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
      authenticate: async (request) => {
        expect(request.method).toBe("POST");
        return { scopes: ["create"] };
      },
    });
    const response = await handle(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "publish", arguments: {} },
      }),
    );
    const body = (await response.json()) as { result: { content: unknown[] } };
    expect(body.result).toEqual({
      content: [{ type: "text", text: "published" }],
    });
  });

  it("treats a null authenticate result as no granted scopes", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
      authenticate: async () => null,
    });
    const response = await handle(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "publish", arguments: {} },
      }),
    );
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JsonRpcErrorCode.InsufficientScope);
  });

  it("returns 401 when the authenticate hook throws McpAuthError, instead of a 500", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
      authenticate: async () => {
        throw new McpAuthError("invalid DPoP proof");
      },
    });
    const response = await handle(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }),
    );
    expect(response.status).toBe(401);
  });

  it("propagates a non-McpAuthError thrown by the authenticate hook, instead of masking it as a 401", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
      authenticate: async () => {
        throw new Error("token store database connection failed");
      },
    });
    await expect(
      handle(post({ jsonrpc: "2.0", id: 1, method: "ping" })),
    ).rejects.toThrow("token store database connection failed");
  });

  it("challenges with a bare Bearer WWW-Authenticate when no metadata URL is configured", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
      authenticate: async () => {
        throw new McpAuthError("invalid DPoP proof");
      },
    });
    const response = await handle(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }),
    );
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("advertises the RFC 9728 protected-resource-metadata URL on 401", async () => {
    const handle = createMcp({
      serverInfo: { name: "s", version: "1" },
      tools: [publishTool],
      authenticate: async () => {
        throw new McpAuthError("invalid DPoP proof");
      },
      protectedResourceMetadataUrl:
        "https://example.com/.well-known/oauth-protected-resource/mcp",
    });
    const response = await handle(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
