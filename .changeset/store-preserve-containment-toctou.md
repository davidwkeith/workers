---
"@dwk/store": minor
"@dwk/solid-pod": patch
"@dwk/remotestorage": patch
---

Close two TOCTOU windows where a containment/conflict invariant was checked
outside the write transaction (#303). Because the Durable Object interleaves at
`await` points (streaming bodies), a concurrent write between the read and the
write could corrupt the invariant.

- `@dwk/store` gains a `preserveWhere` write option: quads matching the predicate
  (e.g. a container's server-managed `ldp:contains`) are re-read **inside** the
  write transaction and merged into the new quad set, so a replacing write can't
  clobber a membership triple a concurrent child write committed since the caller
  built its quad list.
- `@dwk/solid-pod` uses it for RDF `PUT` to an existing container instead of
  reading `ldp:contains` outside the `putResource` transaction, so a concurrent
  child `POST` no longer has its membership triple silently dropped by a stale
  snapshot.
- `@dwk/remotestorage` re-runs its document↔folder collision check inside the
  write transaction via the store `guard` (a `409` now rolls the write back
  atomically), so two racing PUTs to related paths can't both commit into the
  document-shadows-folder collision draft §6 forbids. The pre-write check is
  kept as a cheap early reject.
