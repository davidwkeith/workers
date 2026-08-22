---
"@dwk/atproto-pds": patch
---

Log unhandled XRPC errors: `console.error` at the Durable Object layer (the
only signal that survives the fetch() boundary) and an aggregate
`logger`/`metrics` event at the front door, where the real injected seams are
still in scope, whenever the DO returns a 500.
