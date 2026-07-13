/**
 * The plain-data MCP message dispatcher: routes a parsed JSON-RPC message (or
 * batch) to the lifecycle/registry methods and returns plain response
 * objects. Takes parsed messages in, returns plain objects out — no
 * `Request`/`Response` here; that's `handler.ts`'s job.
 */

import {
  JsonRpcErrorCode,
  McpProtocolError,
  asObjectParams,
  errorResponse,
  isNotification,
  parseRequest,
  successResponse,
} from "./jsonrpc.js";
import { buildInitializeResult } from "./lifecycle.js";
import { ToolRegistry } from "./registry.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpAuthContext,
  McpServerInfo,
  ToolDefinition,
} from "./types.js";

export interface McpServerConfig {
  serverInfo: McpServerInfo;
  tools: ToolDefinition[];
  /** Free-text guidance surfaced in the `initialize` result, e.g. usage hints for the agent. */
  instructions?: string;
}

const NO_SCOPES: McpAuthContext = { scopes: [] };

export interface McpServer {
  /** Dispatch one already-parsed JSON-RPC request; `null` means "no response" (it was a notification). */
  handleMessage(
    message: JsonRpcRequest,
    auth: McpAuthContext,
  ): Promise<JsonRpcResponse | null>;
  /**
   * Dispatch a raw parsed request body — a single request object or a
   * JSON-RPC batch array. `null` means every message in the body was a
   * notification (or the body was empty), so the Streamable HTTP shell
   * should reply `202 Accepted` with no body.
   */
  handleBody(
    body: unknown,
    auth?: McpAuthContext,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
}

export function createMcpServer(config: McpServerConfig): McpServer {
  const registry = new ToolRegistry(config.tools);

  async function handleMessage(
    message: JsonRpcRequest,
    auth: McpAuthContext,
  ): Promise<JsonRpcResponse | null> {
    const notification = isNotification(message);
    const respond = (result: unknown) =>
      notification ? null : successResponse(message.id ?? null, result);

    try {
      switch (message.method) {
        case "initialize":
          return respond(buildInitializeResult(config, message.params));
        case "notifications/initialized":
        case "notifications/cancelled":
          // Notifications by definition — no response even if a client
          // mistakenly attaches an `id`.
          return null;
        case "ping":
          return respond({});
        case "tools/list":
          return respond({ tools: registry.list() });
        case "tools/call": {
          const params = asObjectParams(message.params);
          const result = await registry.call(
            params?.name,
            params?.arguments,
            auth,
          );
          return respond(result);
        }
        default:
          if (notification) return null;
          return errorResponse(
            message.id ?? null,
            JsonRpcErrorCode.MethodNotFound,
            `Unknown method: "${message.method}"`,
          );
      }
    } catch (err) {
      if (notification) return null;
      if (err instanceof McpProtocolError) {
        return errorResponse(
          message.id ?? null,
          err.code,
          err.message,
          err.data,
        );
      }
      // An unexpected (non-protocol) error from a tool handler or the
      // dispatcher itself — never silently swallowed, so production issues
      // stay diagnosable even though the caller only sees "Internal error".
      console.error("@dwk/mcp: internal error handling", message.method, err);
      return errorResponse(
        message.id ?? null,
        JsonRpcErrorCode.InternalError,
        "Internal error",
      );
    }
  }

  async function handleBody(
    body: unknown,
    auth: McpAuthContext = NO_SCOPES,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return errorResponse(
          null,
          JsonRpcErrorCode.InvalidRequest,
          "Batch must not be empty",
        );
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of body) {
        const parsed = parseRequest(item);
        const response =
          "error" in parsed ? parsed : await handleMessage(parsed, auth);
        if (response) responses.push(response);
      }
      return responses.length > 0 ? responses : null;
    }

    const parsed = parseRequest(body);
    if ("error" in parsed) return parsed;
    return handleMessage(parsed, auth);
  }

  return { handleMessage, handleBody };
}
