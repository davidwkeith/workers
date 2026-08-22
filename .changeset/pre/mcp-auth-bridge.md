---
"@dwk/mcp": minor
---

Add the MCP auth bridge (#240): `createDpopBearerAuthenticator` builds the
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
not leak cohort-standard knowledge into the package). The endpoint packages'
tool contributions remain the last increment tracked in #240.
