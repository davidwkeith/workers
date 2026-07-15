# @dwk/mcp

Model Context Protocol server core — a cross-standard reusable lib.

## What this is

A dependency-free JSON-RPC 2.0 + Streamable HTTP server implementing the MCP
tools-only v1 subset (`initialize`, `ping`, `tools/list`, `tools/call`), so
the composed Worker can expose itself as agent-operable tools. Endpoint
packages contribute `ToolDefinition`s (e.g. `@dwk/micropub`'s eventual
`createMicropubMcpTools`); this lib owns only the wire protocol, the tool
registry, and per-tool scope-intersection authorization — never any
IndieWeb/Solid/ActivityPub semantics. **Status: protocol core and auth bridge
implemented**; `createDpopBearerAuthenticator` (`auth.ts`) builds the
`authenticate` hook from a caller-supplied token introspector plus
`@dwk/dpop` proof-of-possession verification, and `buildProtectedResourceMetadata`
(`metadata.ts`) builds the RFC 9728 discovery document for the `401`
challenge. The endpoint packages' tool contributions are the remaining
increment, tracked in
[#240](https://github.com/davidwkeith/workers/issues/240).

## Spec

`spec/packages/mcp.md` — authoritative requirements (the load-bearing
decisions — tools-only subset, auth bridge shape, side-effect posture — were
sketched there before implementation).

## Key constraints

- **Zero cohort-standard knowledge.** No IndieWeb/Solid/ActivityPub imports
  or assumptions — hard constraint for cross-standard libs, same as
  `@dwk/oauth`/`@dwk/http-signatures`. Tool definitions are supplied by the
  composing developer; this package only dispatches by name.
- **Plain-data core, thin HTTP shell.** `jsonrpc.ts`/`lifecycle.ts`/
  `registry.ts`/`server.ts` take parsed messages in, return plain objects —
  no `Request`/`Response`, unit-tested under Node. Only `handler.ts`'s
  `createMcp` touches the Fetch API types.
- **Stateless Streamable HTTP.** Each `POST` is independent; no
  `Mcp-Session-Id`, no SSE resumability. `GET`/`DELETE` are `405` — there is
  no server-initiated stream and no session to terminate. If session state is
  ever added it must live in a strongly-consistent store, never KV.
- **Per-tool least privilege, not a perimeter.** Every `ToolDefinition`
  carries a `requiredScope`; `tools/call` checks it against the caller's
  granted scopes. `createMcp`'s `authenticate(request)` hook is where the
  composing Worker plugs in real token validation; omitting it grants no
  scopes at all, so only `requiredScope: ""` tools are callable.
- **Auth bridge, not a token verifier.** `createDpopBearerAuthenticator`
  (`auth.ts`) builds the `authenticate` hook: it extracts the bearer token,
  calls a caller-supplied `TokenIntrospector` (e.g. `@dwk/indieauth`'s
  `verifyAccessToken`, or a remote RFC 7662 call), completes the DPoP
  proof-of-possession binding via `@dwk/dpop`, and records the proof `jti` in
  a caller-supplied strongly-consistent `DpopReplayStore` (never KV — see
  `@dwk/micropub`'s `replay.ts` for a D1-backed example). This package still
  never verifies a bearer token's signature/introspection itself — that stays
  the composing package's concern, same purity rule as everywhere else.
- **No plain bearer.** DPoP is mandatory everywhere a token is used
  (spec/non-functional-requirements.md); `createDpopBearerAuthenticator`
  always requires a `DPoP` proof header, and
  `buildProtectedResourceMetadata`'s `bearer_methods_supported` is always
  `["DPoP"]`.
- **Dependency-free except `@dwk/dpop`.** No `@modelcontextprotocol/sdk` —
  same call as `@dwk/rdf`'s own JSON-LD subset instead of `jsonld.js`.
  `@dwk/dpop` is a cross-standard lib like this one, so depending on it does
  not leak cohort-standard knowledge in.

## Test environment

Node (`environment: "node"`). No Miniflare — this package never touches a
Cloudflare binding.

```bash
pnpm test --project @dwk/mcp
```

## File layout

```
src/index.ts          # public surface
src/types.ts          # plain-data JSON-RPC + MCP wire types
src/jsonrpc.ts         # JSON-RPC 2.0 envelope parsing, error codes, McpProtocolError
src/lifecycle.ts       # protocol-version negotiation + initialize result
src/registry.ts        # ToolRegistry: tools/list + tools/call, scope checks
src/server.ts          # createMcpServer — plain-data message/batch dispatch
src/handler.ts         # createMcp — the Streamable HTTP shell
src/auth.ts            # createDpopBearerAuthenticator — the MCP auth bridge
src/metadata.ts        # buildProtectedResourceMetadata — RFC 9728 discovery document
src/*.test.ts          # colocated tests
```

## Dependencies

- `@dwk/dpop` — DPoP (RFC 9449) proof-of-possession verification for the auth bridge.

## Depended on by

No workspace packages currently depend on `@dwk/mcp`. The v1 tool
contributions (`@dwk/micropub`, `@dwk/microsub`, `@dwk/webmention`) will be
its first consumers.
