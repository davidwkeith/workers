---
"@dwk/mcp": minor
---

Add `@dwk/mcp` — a [Model Context Protocol](https://modelcontextprotocol.io/specification)
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

The auth bridge (real DPoP/OAuth token validation feeding `authenticate`, via
`@dwk/dpop`/`@dwk/oauth`/`@dwk/indieauth`) and the endpoint packages' tool
contributions (`@dwk/micropub`, `@dwk/microsub`, `@dwk/webmention` first) are
the remaining increments — see `spec/packages/mcp.md` for the load-bearing
decisions. Tracked in #240.
