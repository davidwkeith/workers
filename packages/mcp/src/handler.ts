/**
 * `createMcp` — the thin Streamable HTTP shell. Everything that touches
 * `Request`/`Response` lives here; message dispatch itself is `server.ts`'s
 * plain-data job. Mountable under a path prefix (conventionally `/mcp`) per
 * the composition contract.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

import { JsonRpcErrorCode, errorResponse } from "./jsonrpc.js";
import { createMcpServer, type McpServerConfig } from "./server.js";
import type { McpAuthContext } from "./types.js";

export interface McpHandlerConfig extends McpServerConfig {
  /**
   * Resolve the caller's granted scopes from the incoming request (bearer +
   * DPoP token validation). Omit to run with no scopes granted at all — only
   * tools declared with `requiredScope: ""` are then callable. Wiring real
   * token validation here via `@dwk/dpop`/`@dwk/oauth`/`@dwk/indieauth` is
   * the MCP auth bridge (tracked separately in #240); this protocol core
   * deliberately does not perform it itself.
   */
  authenticate?: (request: Request) => Promise<McpAuthContext | null>;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const NO_SCOPES: McpAuthContext = { scopes: [] };

/**
 * Build the `(request) => Promise<Response>` Streamable HTTP handler for one
 * MCP server instance. Stateless: each `POST` is handled independently, no
 * `Mcp-Session-Id`/SSE resumability in this v1 (spec/packages/mcp.md).
 */
export function createMcp(
  config: McpHandlerConfig,
): (request: Request) => Promise<Response> {
  const server = createMcpServer(config);

  return async function handleMcpRequest(request: Request): Promise<Response> {
    // No server-initiated SSE stream (`GET`) and no session to terminate
    // (`DELETE`) in this stateless v1 — both are protocol-legal 405s.
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        errorResponse(
          null,
          JsonRpcErrorCode.ParseError,
          "Invalid JSON in request body",
        ),
      );
    }

    const auth = config.authenticate
      ? await config.authenticate(request)
      : null;
    const result = await server.handleBody(body, auth ?? NO_SCOPES);

    if (result === null) {
      // All-notification body: Streamable HTTP answers with 202, no body.
      return new Response(null, { status: 202 });
    }
    return jsonResponse(result);
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
  });
}
