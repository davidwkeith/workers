---
"@dwk/server": minor
---

Add `assembleBindings(spec)` to `@dwk/server` — a declarative, package-agnostic
helper that builds the shim-backed `Env` for a set of mounted packages under a
deterministic data-directory layout (`d1/<NAME>.sqlite`, `r2/<NAME>/`,
`kv/<NAME>.sqlite`) and injects secrets as plain `Env` members. It guards against
binding names that are unsafe as path components and against two bindings
colliding on the same `Env` key.

This completes the Phase 2 self-hosting milestone (the D1/R2/KV storage MVP): the
IndieWeb trio plus stateless discovery — `indieauth`, `micropub`, `webmention`,
`webfinger`, `host-meta`, and `vc` — now mount and run end-to-end on
`node:sqlite` + filesystem. A reference composition / acceptance test exercises
authenticated DPoP-bound Micropub publishing, a media upload that lands on disk
and serves back, the Webmention receiver (sync path) enqueuing verification, and
WebFinger/host-meta resolution through the host.
