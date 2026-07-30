---
"@dwk/micropub": patch
---

Background fediverse syndication via `ctx.waitUntil` instead of awaiting it
inline in the create-post response path, so a slow or unreachable fediverse
peer no longer delays the client's response. The MCP tool path (which has no
`ExecutionContext`) is unaffected and still awaits syndication inline.
