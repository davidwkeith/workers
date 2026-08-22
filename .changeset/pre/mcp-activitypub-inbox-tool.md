---
"@dwk/activitypub": minor
---

Add `createActivitypubMcpTools` (#262): a `@dwk/mcp` tool contribution
exposing the read-only `activitypub_list_inbox`, listing this actor's
received activities newest-first. The public `/inbox` route stays
write-only to peers (ActivityPub §7.1), so this reads through a new
internal-only Durable Object route (`__inbox`, parallel to the existing
`__stats`/`__resolve`/`__deliver` routes) rather than reusing any existing
HTTP surface. `forwardedConfig` is now exported from `handler.ts` so the
tool factory can build the same internal request shape the front door
sends, without duplicating it.
