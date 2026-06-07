---
"@dwk/webfinger": patch
---

Return `400` (not `404`) for a present-but-malformed `resource` query parameter,
per RFC 7033 §4.2 ("If the 'resource' parameter is absent **or malformed** … the
server … MUST indicate that the request is bad").

A `resource` with no scheme (e.g. `alice@example.com`) or an unparseable
`http(s)` URI previously fell through to the resolver and returned `404`; it now
fails fast with `400` before any lookup. A new `isWellFormedResource` helper
performs the minimal scheme/URI validation and is exported for reuse. The
rejected-event vocabulary gains a `malformed_resource` reason.
