# @dwk/mcp

A [Model Context Protocol](https://modelcontextprotocol.io/specification)
server core — JSON-RPC 2.0 over Streamable HTTP, a **tools-only v1 subset** —
so an AI agent authorized by the owner can operate the composed Worker on
their behalf: publish via Micropub, read the Microsub timeline, list received
Webmentions, and (later) read/write the pod and the LDN/ActivityPub inboxes.

> **Status: protocol core implemented.** `createMcp` and the message dispatch
> layer are done and unit-tested. The auth bridge (real DPoP/OAuth token
> validation) and the per-package tool contributions
> (`@dwk/micropub`/`@dwk/microsub`/`@dwk/webmention` first) are separate
> increments — see [`spec/packages/mcp.md`](../../spec/packages/mcp.md) and
> [#240](https://github.com/davidwkeith/workers/issues/240).

Like `@dwk/oauth` and `@dwk/http-signatures`, this is a **cross-standard
reusable lib**: it carries zero knowledge of IndieWeb/Solid/ActivityPub. It
implements the wire protocol and a tool registry; the per-standard tool
definitions (e.g. `@dwk/micropub`'s eventual `createMicropubMcpTools`) live in
the endpoint packages.

## What's implemented today

- **`createMcp(config)`** — the Streamable HTTP request handler:
  `initialize` (protocol-version negotiation), `ping`, `tools/list`,
  `tools/call`, JSON-RPC batch + notification handling, and JSON-RPC error
  mapping. `GET`/`DELETE` are `405` (no SSE stream, no session to terminate —
  this v1 is stateless, one `POST` at a time).
- **Per-tool least-privilege scopes.** Every `ToolDefinition` carries a
  `requiredScope`; `tools/call` is checked against the caller's granted
  scopes ∩ that scope — never a perimeter check. A missing/insufficient scope
  is a JSON-RPC error (`-32001`), not a thrown exception.
- **A pluggable `authenticate` hook.** `createMcp` takes an optional
  `authenticate(request): Promise<{ scopes: string[] } | null>`. This package
  never validates a bearer/DPoP token itself — wiring real validation via
  `@dwk/dpop`/`@dwk/oauth`/`@dwk/indieauth` is the separate **auth bridge**
  increment. Omit the hook and only zero-scope tools (`requiredScope: ""`)
  are callable.
- **Dependency-free.** No `@modelcontextprotocol/sdk` — the same call this
  repo already made for `@dwk/rdf`'s own JSON-LD subset over `jsonld.js`.

The protocol core (`server.ts`, `registry.ts`, `lifecycle.ts`, `jsonrpc.ts`) is
plain-data and unit-tests under Node without a Workers runtime; only the thin
`createMcp` HTTP shell (`handler.ts`) touches `Request`/`Response`.

## Usage

```ts
import { createMcp, type ToolDefinition } from "@dwk/mcp";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes back its input.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { readOnlyHint: true },
  requiredScope: "",
  handler: (args) => ({
    content: [{ type: "text", text: String(args.text ?? "") }],
  }),
};

const handleMcpRequest = createMcp({
  serverInfo: { name: "example-worker", version: "1.0.0" },
  tools: [echoTool],
  // authenticate: async (request) => resolveScopesFromDpopToken(request),
});

export default {
  fetch: (request: Request) =>
    new URL(request.url).pathname === "/mcp"
      ? handleMcpRequest(request)
      : new Response("Not found", { status: 404 }),
};
```

## What's not here yet

- **Resources, prompts, sampling, elicitation.** Tools-only v1 by design.
- **The stdio transport and session resumability.** Streamable HTTP only,
  stateless.
- **Token validation.** `authenticate` is a caller-supplied hook; the
  DPoP-bound bearer-token verification and RFC 9728 protected-resource
  metadata are the auth-bridge increment.
- **Tool contributions.** The endpoint packages' `createXMcpTools` factories
  land alongside this lib as their own increments.

## License

ISC
