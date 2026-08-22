---
"@dwk/remotestorage": minor
"@dwk/store": minor
---

Add `@dwk/remotestorage` — an Unhosted-style remoteStorage
(draft-dejong-remotestorage) personal data vault that rides on the **same**
`@dwk/store` backing store the Solid Pod uses (issue #105).

- **`createRemoteStorage(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` front door, mountable under any path
  prefix; **`RemoteStorageObject`** is the per-account Durable Object (the
  consistency authority, reusing `@dwk/store`'s blob tier); and
  **`createRemoteStorageGc(config)`** is the shared R2 GC cron handler.
- **Documents:** `GET`/`HEAD`/`PUT`/`DELETE` with strong `ETag`s, `If-Match` /
  `If-None-Match: *` conditional writes checked TOCTOU-free inside the store
  transaction (`412`), oversized bodies streamed straight to R2, and `409`
  document↔folder name-collision detection.
- **Folders:** `GET <path>/` returns the `application/ld+json` folder
  description (immediate children + per-subfolder aggregate ETags) with a folder
  `ETag` derived from a SHA-256 over **every** descendant, so it changes whenever
  anything in the subtree does. Folders are virtual; an empty folder still
  answers `200`.
- **Auth:** plain OAuth 2.0 bearer tokens (built-in JWKS verifier or an
  injectable hook for opaque/introspected tokens) with per-module `:r`/`:rw`
  **scopes** and a public `/public/` document tree (folder listings never
  public). Permissive CORS on every response, preflight answered at the edge.
- **Discovery:** `remoteStorageLink()` builds the WebFinger link advertising a
  user's storage root and OAuth endpoint for `@dwk/webfinger`.

`@dwk/store` gains a single **generic** `Store.list(prefix)` projection — every
resource pointer whose key starts with `prefix`, with `LIKE` metacharacters
escaped — used here to derive folder listings/ETags. It ascribes no meaning to
`/` or "folders", so it does not taint the store with remoteStorage assumptions
(`@dwk/solid-pod` could use it for LDP container enumeration too).
