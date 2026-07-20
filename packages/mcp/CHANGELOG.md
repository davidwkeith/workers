# @dwk/mcp

## 0.1.0-beta.0

### Minor Changes

- Add `@dwk/mcp` — a [Model Context Protocol](https://modelcontextprotocol.io/specification)
  server core, so an AI agent authorized by the owner can operate the composed
  Worker on their behalf (publish via Micropub, read the Microsub timeline, list
  received Webmentions, and eventually read/write the pod). Prompted by a review
  of Cloudflare's [agentic-inbox](https://github.com/cloudflare/agentic-inbox);
  this cohort's version fixes its single-trust-boundary weak point with
  per-tool scope checks instead.

  This first beta ships the **protocol core** (dependency-free, no
  `@modelcontextprotocol/sdk`), all unit-tested under Node:
  - **`createMcp(config)`** — the Streamable HTTP request handler for a
    **tools-only v1** subset: `initialize` (protocol-version negotiation),
    `ping`, `tools/list`, `tools/call`, JSON-RPC 2.0 batch + notification
    handling, and JSON-RPC error mapping. `GET`/`DELETE` are `405` — this v1 is
    stateless, one `POST` at a time, no `Mcp-Session-Id`/SSE resumability.
  - **Per-tool least-privilege scopes** — every `ToolDefinition` carries a
    `requiredScope`; `tools/call` checks it against the caller's granted scopes
    via a pluggable `authenticate(request)` hook, never a single perimeter
    check.

  Tracked in #240.

- Add the MCP auth bridge (#240): `createDpopBearerAuthenticator` builds the
  `authenticate(request)` hook `createMcp` accepts, wiring bearer +
  **DPoP-bound** access tokens per spec/packages/mcp.md. It never verifies a
  token's signature or looks it up itself — the composing package supplies a
  `TokenIntrospector` closure (e.g. `@dwk/indieauth`'s `verifyAccessToken`, or a
  remote RFC 7662 call) — but it does complete the DPoP proof-of-possession
  binding via `@dwk/dpop` and record the proof `jti` in a caller-supplied
  strongly-consistent `DpopReplayStore` (never KV), rejecting a replayed proof.

  Also adds `buildProtectedResourceMetadata` (RFC 9728), and
  `McpHandlerConfig.protectedResourceMetadataUrl` so a `401` carries a
  `WWW-Authenticate: Bearer resource_metadata="…"` challenge pointing an MCP
  client at the authorization server. `McpAuthContext` gains an optional
  `subject` field, surfaced from the introspected token.

  `@dwk/mcp` now depends on `@dwk/dpop` (both cross-standard libs, so this does
  not leak cohort-standard knowledge into the package).
