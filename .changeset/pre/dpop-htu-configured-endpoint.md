---
"@dwk/micropub": patch
"@dwk/microsub": patch
---

Bind the DPoP proof's `htu` to the configured endpoint URL instead of
`request.url` (#300). Both resource servers verified the proof against
`request.url`, but a client signs the **public** endpoint it POSTs to — behind
the path-rewriting proxy the mountable-prefix composition targets, `request.url`
is the rewritten internal URL, so every DPoP proof failed with `htu_mismatch`, a
hard outage. `authorize` now takes the expected `htu` from the caller and each
call site passes the relevant configured endpoint (`micropubEndpoint` /
`mediaEndpoint` / `microsubEndpoint`), matching what `@dwk/indieauth`'s token
endpoint already does.
