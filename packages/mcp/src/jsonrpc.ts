/**
 * JSON-RPC 2.0 envelope parsing, error codes, and response builders. Plain
 * data in, plain data out — no HTTP, no MCP method dispatch.
 *
 * @see https://www.jsonrpc.org/specification
 */

import type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from "./types.js";

/** Standard JSON-RPC 2.0 codes, plus one MCP-server-defined code in the reserved `-32000`–`-32099` band. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The token's granted scopes don't include the tool's `requiredScope`. */
  InsufficientScope: -32001,
} as const;

/** Thrown by MCP method handlers for protocol-level failures; caught by the dispatcher and mapped to a JSON-RPC error response. */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

export function successResponse(
  id: JsonRpcId,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** A request with no `id` member at all is a notification (JSON-RPC 2.0 §4.1); `id: null` is a request, not a notification. */
export function isNotification(message: JsonRpcRequest): boolean {
  return !("id" in message);
}

/** Narrow `params` to a plain object; arrays and scalars (both legal JSON-RPC `params`, but never used by MCP) are treated as absent. */
export function asObjectParams(
  params: unknown,
): Record<string, unknown> | undefined {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return undefined;
}

/** Validate a raw parsed JSON value as a single JSON-RPC 2.0 request object. */
export function parseRequest(
  value: unknown,
): JsonRpcRequest | JsonRpcErrorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return errorResponse(
      null,
      JsonRpcErrorCode.InvalidRequest,
      "Request must be a JSON object",
    );
  }
  const obj = value as Record<string, unknown>;

  if (obj.jsonrpc !== "2.0") {
    return errorResponse(
      idOf(obj),
      JsonRpcErrorCode.InvalidRequest,
      '"jsonrpc" must be "2.0"',
    );
  }
  if (typeof obj.method !== "string" || obj.method.length === 0) {
    return errorResponse(
      idOf(obj),
      JsonRpcErrorCode.InvalidRequest,
      '"method" must be a non-empty string',
    );
  }
  if (
    obj.params !== undefined &&
    (typeof obj.params !== "object" || obj.params === null)
  ) {
    return errorResponse(
      idOf(obj),
      JsonRpcErrorCode.InvalidRequest,
      '"params" must be an object or array',
    );
  }
  if (
    obj.id !== undefined &&
    obj.id !== null &&
    typeof obj.id !== "string" &&
    typeof obj.id !== "number"
  ) {
    return errorResponse(
      null,
      JsonRpcErrorCode.InvalidRequest,
      '"id" must be a string, number, or null',
    );
  }

  return {
    jsonrpc: "2.0",
    ...(obj.id !== undefined ? { id: obj.id as JsonRpcId } : {}),
    method: obj.method,
    ...(obj.params !== undefined
      ? { params: obj.params as Record<string, unknown> | unknown[] }
      : {}),
  };
}

function idOf(obj: Record<string, unknown>): JsonRpcId {
  const id = obj.id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}
