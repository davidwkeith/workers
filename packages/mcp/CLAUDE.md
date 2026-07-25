# @dwk/mcp

Model Context Protocol server core — a cross-standard reusable lib.

## What this is

A dependency-free JSON-RPC 2.0 + Streamable HTTP server implementing the MCP
tools-only v1 subset (`initialize`, `ping`, `tools/list`, `tools/call`), so
the composed Worker can expose itself as agent-operable tools. Endpoint
packages contribute `ToolDefinition`s (`@dwk/micropub`'s
`createMicropubMcpTools`, `@dwk/microsub`'s `createMicrosubMcpTools`,
`@dwk/webmention`'s `createWebmentionMcpTools`); this lib owns only the wire
protocol, the tool registry, and per-tool scope-intersection authorization —
never any IndieWeb/Solid/ActivityPub semantics. **Status: protocol core, auth
bridge, and both the v1 and v2 tool contributions are implemented**;
`createDpopBearerAuthenticator` (`auth.ts`) builds the `authenticate` hook
from a caller-supplied token introspector plus `@dwk/dpop`
proof-of-possession verification, and `buildProtectedResourceMetadata`
(`metadata.ts`) builds the RFC 9728 discovery document for the `401`
challenge. `@dwk/solid-pod`'s pod CRUD (`solid_pod_read`/`solid_pod_write`)
and `@dwk/activitypub`'s inbox read (`activitypub_list_inbox`) — the v2
scope — shipped in
[#262](https://github.com/davidwkeith/workers/issues/262).

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
