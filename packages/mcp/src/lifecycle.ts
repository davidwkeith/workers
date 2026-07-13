/**
 * MCP lifecycle: protocol-version negotiation and the `initialize` result.
 * Tools-only v1 — capabilities never advertise resources/prompts/sampling.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 */

import { asObjectParams } from "./jsonrpc.js";
import type { InitializeResult, McpServerInfo } from "./types.js";

/**
 * Revisions this server accepts verbatim from the client's `initialize`
 * request. Pinning to a small, explicit set (rather than "anything") is
 * deliberate: see spec/packages/mcp.md's open question on protocol-revision
 * pinning.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
] as const;

export const LATEST_PROTOCOL_VERSION: string = "2025-06-18";

/**
 * If the client requested a revision we support, echo it back; otherwise
 * respond with our latest — per spec, the client then decides whether to
 * proceed or disconnect.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export function buildInitializeResult(
  config: { serverInfo: McpServerInfo; instructions?: string },
  params: unknown,
): InitializeResult {
  const protocolVersion = negotiateProtocolVersion(
    asObjectParams(params)?.protocolVersion,
  );
  return {
    protocolVersion,
    // listChanged: false — this v1 registry is static for the lifetime of one
    // `createMcp` instance; there is no `tools/list_changed` notification to send.
    capabilities: { tools: { listChanged: false } },
    serverInfo: config.serverInfo,
    ...(config.instructions !== undefined
      ? { instructions: config.instructions }
      : {}),
  };
}
