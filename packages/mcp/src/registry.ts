/**
 * The tool registry: `tools/list` listing and `tools/call` dispatch, with
 * per-tool least-privilege scope checks (granted scopes ∩ the tool's
 * `requiredScope` — never a perimeter check). Endpoint packages supply
 * `ToolDefinition`s; this module owns no protocol/standard knowledge of its own.
 */

import { JsonRpcErrorCode, McpProtocolError } from "./jsonrpc.js";
import type {
  McpAuthContext,
  ToolCallResult,
  ToolDefinition,
  ToolListing,
} from "./types.js";

export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(tools: ToolDefinition[]) {
    const map = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      if (map.has(tool.name)) {
        throw new Error(`@dwk/mcp: duplicate tool name "${tool.name}"`);
      }
      map.set(tool.name, tool);
    }
    this.tools = map;
  }

  list(): ToolListing[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));
  }

  async call(
    name: unknown,
    args: unknown,
    auth: McpAuthContext,
  ): Promise<ToolCallResult> {
    if (typeof name !== "string" || name.length === 0) {
      throw new McpProtocolError(
        JsonRpcErrorCode.InvalidParams,
        '"name" must be a non-empty string',
      );
    }
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpProtocolError(
        JsonRpcErrorCode.InvalidParams,
        `Unknown tool: "${name}"`,
      );
    }
    if (
      args !== undefined &&
      (typeof args !== "object" || args === null || Array.isArray(args))
    ) {
      throw new McpProtocolError(
        JsonRpcErrorCode.InvalidParams,
        '"arguments" must be an object',
      );
    }
    if (
      tool.requiredScope !== "" &&
      (!auth?.scopes || !auth.scopes.includes(tool.requiredScope))
    ) {
      throw new McpProtocolError(
        JsonRpcErrorCode.InsufficientScope,
        `Calling "${name}" requires the "${tool.requiredScope}" scope`,
      );
    }
    return tool.handler(
      (args as Record<string, unknown> | undefined) ?? {},
      auth,
    );
  }
}
