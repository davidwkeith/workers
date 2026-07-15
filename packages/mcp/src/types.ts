/**
 * Plain-data types for the MCP tools-only v1 subset: JSON-RPC 2.0 envelopes
 * plus the `initialize`/`tools/list`/`tools/call` payload shapes.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18
 */

export type JsonRpcId = string | number | null;

/** A JSON-RPC 2.0 request. Absence of `id` (not `id: null`) marks a notification. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: {
    listChanged?: boolean;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
  instructions?: string;
}

/** MCP tool annotations (spec §"Tool annotations") — a hint, never a security boundary. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    };

export interface ToolCallResult {
  content: ToolContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * The caller's granted scopes, already resolved by the composing Worker's auth
 * bridge (DPoP-bound token validated via `@dwk/dpop`/`@dwk/oauth`/
 * `@dwk/indieauth` — see spec/packages/mcp.md, and this package's
 * `createDpopBearerAuthenticator`). This lib never validates a token itself;
 * it only intersects `scopes` against each tool's `requiredScope`.
 */
export interface McpAuthContext {
  scopes: string[];
  /** The token's subject (e.g. the owner's `me`), when the auth bridge resolved one. */
  subject?: string;
}

/**
 * A tool contribution, e.g. from `@dwk/micropub`'s `createMicropubMcpTools`.
 * `requiredScope: ""` means the tool needs no scope (callable by any caller
 * the transport let through).
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  requiredScope: string;
  handler: (
    args: Record<string, unknown>,
    auth: McpAuthContext,
  ) => Promise<ToolCallResult> | ToolCallResult;
}

/** The `tools/list` wire shape for one tool — `requiredScope`/`handler` stay server-side. */
export interface ToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}
