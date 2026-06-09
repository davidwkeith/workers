# @dwk/store

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/rdf@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.
- 0c21c6b: Add `@dwk/remotestorage` — an Unhosted-style remoteStorage
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

- ee7531f: Implement `@dwk/store`: a single storage interface over the DO-SQLite quad store
  and R2 blob bodies, run inside the `@dwk/solid-pod` Durable Object.
  Transactional quad reads/writes and N3-Patch `deletes`+`inserts` apply in one
  `transactionSync`, with TOCTOU-free `If-Match` check-and-write. Blob bodies are
  content-addressed and copy-on-write (write the new R2 object, then atomically
  flip the DO pointer), streamed on read and never buffered. Size-threshold
  routing keeps small RDF in SQLite and offloads bodies over the ~2 MB DO-cell
  ceiling to R2. Deletes drop the pointer first and record orphaned keys to a
  transactional outbox in the same SQLite transaction; `forwardOrphans` drains it
  into a shared D1 tracking store and `collectGarbage` reclaims R2 objects after a
  safety window using only D1 and R2 — never sweeping or waking a per-pod Durable
  Object.

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- b1e4180: Close three DPoP `jti` replay-enforcement gaps in `@dwk/solid-pod` writes
  (issue #34):
  - **Replay TTL now covers the full proof-acceptance window.** `@dwk/dpop`
    accepts a proof whose `iat` lands anywhere in `±DEFAULT_MAX_AGE_SECONDS`, so a
    single proof stays valid across a `2 × DEFAULT_MAX_AGE_SECONDS` span. The
    replay row's TTL is anchored to that window (`2 × DEFAULT_MAX_AGE_SECONDS`)
    instead of a bare 5 minutes, so a row can no longer be pruned while its proof
    is still cryptographically acceptable.
  - **A `jti` is consumed atomically with the write.** Replay consumption moved
    from before the write into the store's write `transactionSync`, after the
    `If-Match` / `solid:where` preconditions pass. A `412` (stale ETag) or `409`
    (patch no-match) now rolls the replay row back with the write, leaving the
    proof reusable for a legitimate retry instead of burning it. `@dwk/store`
    gains a transactional `guard` hook on `WriteOptions` (generalizing the
    existing delete guard), run inside the write transaction after the
    precondition check, so `writeQuads` / `patchQuads` / `putBlob` can commit the
    replay row atomically with the write.
  - **Anonymous writes are gated by config.** A tokenless (proof-less) write
    carries no `jti` and therefore no replay / anti-abuse protection. Such a write
    is now refused `401` by default even where a public-write ACL
    (`acl:agentClass foaf:Agent`) would permit it; set the new
    `allowAnonymousWrites: true` to opt into public write as an explicit,
    documented tradeoff.

- ce0a851: Fix a TOCTOU in `@dwk/solid-pod` write/delete preconditions (#29). Create-only
  (`If-None-Match: *`) and `If-Match` were evaluated against `store.head()`
  outside the write transaction, with an `await request.arrayBuffer()` between the
  check and the transactional write — so two concurrent `PUT If-None-Match: *`
  could both pass and both write, breaking the create-only guarantee.

  `@dwk/store` now takes `ifNoneMatch` in `WriteOptions` and enforces both
  preconditions inside the same `transactionSync` as the pointer write, and
  `delete` accepts an optional in-transaction `guard`. `@dwk/solid-pod` threads
  the request preconditions into the store write and re-checks LDP container
  emptiness inside the delete transaction, closing the check-and-write gap.

- f3332f2: Fix content-addressed blob keys causing cross-resource ETag collisions and
  shared `Content-Type` overwrites (#40). Blob keys stay content-addressed
  (`sha256-…`) so identical bytes still dedupe to one R2 object, but two side
  effects are removed:
  - **ETag collisions:** `putBlob` derived the ETag from the content hash, so two
    distinct resources holding identical bytes returned the same ETag — an
    `If-Match` against resource A's ETag would also be satisfied by an unrelated
    resource B. Blob ETags are now fresh per-write opaque validators
    (`randomEtag()`), matching how RDF writes already behave, while the content
    hash remains the R2 key for dedup.
  - **Shared-key `Content-Type` overwrite:** each write re-`put` the shared
    content-addressed object with its own `httpMetadata.contentType`, so a
    direct/public bucket read of one resource could return another writer's
    content type. The per-object `httpMetadata` claim is dropped; the
    authoritative content type lives on the per-resource pointer and reads go
    through the Worker.

- 4ab1926: Harden the blob GC resurrection guard against the timestamp race that could
  delete a live, resurrected object (#33). Because blob keys are content-addressed,
  a deleted key can be legitimately resurrected by a later `putBlob` of identical
  content, and the old guard decided liveness purely by comparing R2's
  second-resolution `uploaded` against the DO's `enqueued_at` — racy across the
  `head`→`delete` window and across clock skew / sub-second deletes-then-recreates.
  - `collectGarbage` is now **version-conditional**: it captures the object's R2
    `version` at `head` time and re-checks it immediately before deleting, so a
    resurrection landing in that window aborts the delete (R2 bindings have no
    atomic conditional delete; this head→delete recheck is the tightest guard
    available). The timestamp heuristic now requires `uploaded` to exceed
    `enqueued_at` by a configurable `clockSkewMs` margin (default 5s).
  - `putBlob`'s resurrection guard now also cancels an **already-forwarded** GC
    row, not just the local outbox row: forwarded outbox rows are retained for a
    retention window and a resurrection records an "un-orphan" tombstone that
    `forwardOrphans` propagates to the shared store (cancels before inserts).
  - The shared `orphan_blobs` D1 table dedups on a UNIQUE `blob_key`, keeping the
    **max** `enqueued_at`, so at-least-once forwarding and re-orphaning never
    shorten a key's safety window.

- dd82841: Fix `putBlob` leaking an unreclaimable R2 orphan on a precondition failure
  (#32). The content-addressed `put` happened unconditionally before the
  transaction that evaluates `If-Match` / `If-None-Match`, so a failed
  precondition left a freshly-written object that was never recorded to the
  orphan outbox — and the full-sweep-free GC (which only reclaims keys reported
  via the outbox) could never discover it.

  `putBlob` now pre-checks the precondition against the current pointer before
  writing to R2, so a deterministic failure rejects without landing an object.
  The in-transaction check remains the TOCTOU-free authority; if the transaction
  rolls back after the object has landed — a concurrent write moving the pointer,
  or any other failure — the just-written key is recorded to the outbox (when no
  live resource references it) before the original error is re-thrown, so GC can
  still reclaim it.

- 05ee6b2: Stop buffering the full body on the blob **write** path, honouring the
  "stream R2 bodies through the Worker — never buffer a blob in the DO" mandate
  (#31). Previously three write paths materialised the entire body in memory —
  exactly for the oversized bodies routed to R2 because they exceed the ~2 MB cell
  ceiling (up to the 128 MB limit).
  - `@dwk/store`: `putBlob` now accepts a `ReadableStream`/`Blob` and hashes it
    with a `DigestStream` while streaming it to a staging key, then promotes the
    staged object to its content-addressed key (skipped when an identical body
    already exists, so writes still dedupe) — the DO never holds the whole body.
    In-memory `ArrayBuffer`/`Uint8Array` inputs keep the direct write path.
  - `@dwk/solid-pod`: `#writeBody` routes on the declared `Content-Length` — a
    body known to fit the cell is read into memory (bounded) and, if RDF, parsed
    into quads; anything larger is streamed straight to R2. An undeclared length
    is probed only up to the ceiling; a body that overflows the probe is rejected
    with `411 Length Required` rather than buffered whole. The front door forwards
    `Content-Length` to the DO for this routing.
  - `@dwk/micropub`: the media endpoint and multipart create now reject an upload
    whose `Content-Length` exceeds `maxMediaBytes` (with `413`) _before_
    `formData()` reads the body into memory.

- Updated dependencies [65cab2c]
- Updated dependencies [ac90fce]
- Updated dependencies [3a806d9]
- Updated dependencies [9224fd7]
  - @dwk/rdf@0.1.0-beta.0
