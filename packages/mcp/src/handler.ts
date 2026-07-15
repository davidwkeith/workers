/**
 * `createMcp` — the thin Streamable HTTP shell. Everything that touches
 * `Request`/`Response` lives here; message dispatch itself is `server.ts`'s
 * plain-data job. Mountable under a path prefix (conventionally `/mcp`) per
 * the composition contract.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

import { McpAuthError } from "./auth.js";
import { JsonRpcErrorCode, errorResponse } from "./jsonrpc.js";
import { createMcpServer, type McpServerConfig } from "./server.js";
import type { McpAuthContext } from "./types.js";

export interface McpHandlerConfig extends McpServerConfig {
  /**
   * Resolve the caller's granted scopes from the incoming request (bearer +
   * DPoP token validation) — see this package's `createDpopBearerAuthenticator`
   * for a ready-made implementation. Omit to run with no scopes granted at
   * all — only tools declared with `requiredScope: ""` are then callable.
   *
   * Throw {@link McpAuthError} to signal a genuine authentication failure
   * (invalid/expired/replayed token, missing proof) — that maps to a `401`.
   * Any other thrown error is treated as an internal failure (e.g. a token
   * store or database outage) and propagates instead of being masked as a
   * client-facing `401`.
   */
  authenticate?: (request: Request) => Promise<McpAuthContext | null>;

  /**
   * The RFC 9728 protected-resource-metadata URL to advertise on a `401`
   * (`WWW-Authenticate: Bearer resource_metadata="…"`), so an MCP client can
   * discover the authorization server. The document itself is built with
   * this package's `buildProtectedResourceMetadata` and served outside this
   * handler's mount (spec/packages/mcp.md "Auth bridge").
   */
  protectedResourceMetadataUrl?: string;
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

    let auth: McpAuthContext | null = null;
    if (config.authenticate) {
      try {
        auth = await config.authenticate(request);
      } catch (err) {
        // Only a declared auth failure maps to 401; anything else (a store
        // or database outage inside the hook, say) propagates rather than
        // being misreported to the client as an invalid token.
        if (err instanceof McpAuthError) {
          return unauthorized(config.protectedResourceMetadataUrl);
        }
        throw err;
      }
    }
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

/**
 * `401` with a `WWW-Authenticate` challenge. When a protected-resource
 * metadata URL is configured, the challenge carries `resource_metadata`
 * (RFC 9728 §5.1) so an MCP client can discover the authorization server.
 */
function unauthorized(resourceMetadataUrl?: string): Response {
  const challenge = resourceMetadataUrl
    ? `Bearer resource_metadata="${resourceMetadataUrl}"`
    : "Bearer";
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain",
      "www-authenticate": challenge,
    },
  });
}
