import { describe, expect, it } from "vitest";
import { McpProtocolError, JsonRpcErrorCode } from "./jsonrpc.js";
import { ToolRegistry } from "./registry.js";
import type { McpAuthContext, ToolDefinition } from "./types.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes back its input.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { readOnlyHint: true, openWorldHint: false },
  requiredScope: "",
  handler: (args) => ({
    content: [{ type: "text", text: String(args.text ?? "") }],
  }),
};

const publishTool: ToolDefinition = {
  name: "publish",
  description: "Publishes a post.",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: false, destructiveHint: true },
  requiredScope: "create",
  handler: () => ({ content: [{ type: "text", text: "published" }] }),
};

const NO_SCOPES: McpAuthContext = { scopes: [] };

describe("ToolRegistry construction", () => {
  it("throws on duplicate tool names", () => {
    expect(() => new ToolRegistry([echoTool, { ...echoTool }])).toThrow(
      /duplicate tool name/i,
    );
  });
});

describe("ToolRegistry#list", () => {
  it("lists tools with their wire-facing fields only, annotations passed through verbatim", () => {
    const registry = new ToolRegistry([echoTool, publishTool]);
    expect(registry.list()).toEqual([
      {
        name: "echo",
        description: echoTool.description,
        inputSchema: echoTool.inputSchema,
        annotations: echoTool.annotations,
      },
      {
        name: "publish",
        description: publishTool.description,
        inputSchema: publishTool.inputSchema,
        annotations: publishTool.annotations,
      },
    ]);
  });

  it("omits the annotations key entirely when a tool declares none", () => {
    const noAnnotations: ToolDefinition = {
      ...echoTool,
      annotations: undefined,
    };
    const registry = new ToolRegistry([noAnnotations]);
    expect("annotations" in registry.list()[0]!).toBe(false);
  });

  it("never leaks requiredScope or handler onto the wire", () => {
    const registry = new ToolRegistry([publishTool]);
    const listing = registry.list()[0]! as unknown as Record<string, unknown>;
    expect("requiredScope" in listing).toBe(false);
    expect("handler" in listing).toBe(false);
  });
});

describe("ToolRegistry#call", () => {
  it("calls a zero-scope tool with no token at all", async () => {
    const registry = new ToolRegistry([echoTool]);
    const result = await registry.call("echo", { text: "hi" }, NO_SCOPES);
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("allows a scoped tool when the granted scopes include the required scope", async () => {
    const registry = new ToolRegistry([publishTool]);
    const result = await registry.call(
      "publish",
      {},
      { scopes: ["create", "read"] },
    );
    expect(result).toEqual({ content: [{ type: "text", text: "published" }] });
  });

  it("rejects a scoped tool call with no token (no granted scopes)", async () => {
    const registry = new ToolRegistry([publishTool]);
    await expect(registry.call("publish", {}, NO_SCOPES)).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.InsufficientScope,
      },
    );
  });

  it("rejects a scoped tool call whose granted scopes don't include the required one", async () => {
    const registry = new ToolRegistry([publishTool]);
    await expect(
      registry.call("publish", {}, { scopes: ["read"] }),
    ).rejects.toBeInstanceOf(McpProtocolError);
  });

  it("rejects an unknown tool name", async () => {
    const registry = new ToolRegistry([echoTool]);
    await expect(
      registry.call("nonexistent", {}, NO_SCOPES),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it("rejects a non-string tool name", async () => {
    const registry = new ToolRegistry([echoTool]);
    await expect(registry.call(42, {}, NO_SCOPES)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it("rejects non-object arguments", async () => {
    const registry = new ToolRegistry([echoTool]);
    await expect(
      registry.call("echo", "nope", NO_SCOPES),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    await expect(
      registry.call("echo", ["nope"], NO_SCOPES),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it("defaults missing arguments to an empty object", async () => {
    const registry = new ToolRegistry([echoTool]);
    const result = await registry.call("echo", undefined, NO_SCOPES);
    expect(result).toEqual({ content: [{ type: "text", text: "" }] });
  });
});
