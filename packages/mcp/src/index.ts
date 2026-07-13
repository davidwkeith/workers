/**
 * `@dwk/mcp` — Model Context Protocol server core.
 *
 * A cross-standard reusable lib (like `@dwk/oauth`, `@dwk/http-signatures`):
 * MCP is an open, versioned protocol with no IndieWeb/Solid semantics of its
 * own, so this package carries **zero knowledge of any cohort standard**.
 * It implements the wire protocol — JSON-RPC 2.0 over Streamable HTTP — and a
 * tool registry; per-standard tool definitions live in the endpoint packages
 * (e.g. `@dwk/micropub`'s eventual `createMicropubMcpTools`), the same
 * adapter rule as `@dwk/calendar`.
 *
 * **v1 is tools-only**: `initialize`, `ping`, `tools/list`, `tools/call`.
 * Resources, prompts, sampling, elicitation, and the stdio transport are out
 * of scope. Dependency-free — no `@modelcontextprotocol/sdk` — the same call
 * this repo already made for `@dwk/rdf`'s JSON-LD subset over `jsonld.js`.
 *
 * The protocol core (`server.ts`, `registry.ts`, `lifecycle.ts`,
 * `jsonrpc.ts`) is plain-data and unit-tests under Node without a Workers
 * runtime; only the thin `createMcp` HTTP shell (`handler.ts`) touches
 * `Request`/`Response`. Authentication is a caller-supplied
 * `authenticate(request)` hook — this lib never validates a bearer/DPoP token
 * itself; it only intersects the resolved scopes against each tool's
 * `requiredScope`. Wiring real token validation via `@dwk/dpop`/`@dwk/oauth`/
 * `@dwk/indieauth` is the separate MCP auth-bridge increment tracked in #240.
 *
 * @see spec/packages/mcp.md
 * @packageDocumentation
 */

export { createMcp, type McpHandlerConfig } from "./handler.js";

export {
  createMcpServer,
  type McpServer,
  type McpServerConfig,
} from "./server.js";

export { ToolRegistry } from "./registry.js";

export {
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  buildInitializeResult,
} from "./lifecycle.js";

export {
  JsonRpcErrorCode,
  McpProtocolError,
  successResponse,
  errorResponse,
  isNotification,
  asObjectParams,
  parseRequest,
} from "./jsonrpc.js";

export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  McpServerInfo,
  McpCapabilities,
  InitializeResult,
  ToolAnnotations,
  ToolContentBlock,
  ToolCallResult,
  McpAuthContext,
  ToolDefinition,
  ToolListing,
} from "./types.js";
