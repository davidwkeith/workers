---
"@dwk/esi": minor
---

Add `@dwk/esi` — a streaming Edge Side Includes processor (`processEsi`)
that resolves `<esi:include>`/`<esi:comment>`/`<esi:remove>` markup in a
Response body, fetching fragments concurrently through `@dwk/safe-fetch`.
