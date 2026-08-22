---
"@dwk/activitypub": patch
---

Gate the owner-only internal Durable Object routes (`__inbox`, `__following`)
behind an explicit internal marker header (#310). These routes have no public
front-door equivalent, but the DO served them on path match to any request
carrying the front-door config header — so a future front-door route that
forwarded such a path could expose the owner's inbox. The trusted callers (the
`@dwk/mcp` tool and the community-syndication provider) now set an
`x-ap-internal` marker, and the DO refuses those routes with `404` without it —
defense in depth, mirroring `@dwk/solid-pod`'s internal-route markers.
