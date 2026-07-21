---
"@dwk/solid-pod": patch
"@dwk/remotestorage": patch
---

`@dwk/solid-pod`: dropped `readReplayWindowSeconds` from `SolidPodConfig` —
it was plumbed through to `ResolvedConfig` but never consulted anywhere (no
read-side DPoP replay-window check was ever wired to it), so the config
surface promised behavior nothing implemented. `listChildren`'s WebDAV
backend now defensively drops a child IRI that isn't actually same-origin
(relevant if a forged `ldp:contains` triple, see #337, ever reaches the quad
store) instead of slicing it into a bogus, non-`/`-rooted path.

`@dwk/solid-pod` and `@dwk/remotestorage`: documented the existing
`#getStore` per-isolate caching assumption (`maxInlineBytes` is taken from
whichever request builds the store first, for the DO's lifetime) — no
behavior change.
