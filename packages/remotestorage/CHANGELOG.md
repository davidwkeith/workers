# @dwk/remotestorage

## 1.0.0-beta.2

### Patch Changes

- ec0f4a2: Log an unexpected Durable Object storage error via `console.error` (in the
  `@dwk/log` `consoleLogger` record shape) before rethrowing it, instead of the
  error vanishing silently — the front door's injected `Logger`/`Metrics`
  cannot cross the DO `fetch()` boundary, so this is the only signal available
  at that layer.
- Updated dependencies [d54ad2d]
  - @dwk/webfinger@1.0.0-beta.2

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/log@1.0.0-beta.1
  - @dwk/store@1.0.0-beta.1
  - @dwk/webfinger@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5
  - @dwk/store@0.1.0-beta.5
  - @dwk/webfinger@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- 36a3be1: Negative-cache a failed JWKS fetch so a token burst can't hammer the issuer
  (#304). On a JWKS fetch failure (non-ok, malformed body, or thrown) with no
  cached keys, `resolveJwks` returned without recording the failure, so every
  presented-token request re-fetched the JWKS URI — an amplification/DoS vector
  against the issuer's endpoint while it is down. A failed fetch is now recorded
  with a short backoff (30s): within the window the last good keys are served if
  available (else the request is rejected), but the issuer is not re-hit on every
  request.
- 3e505be: `@dwk/solid-pod`: dropped `readReplayWindowSeconds` from `SolidPodConfig` —
  it was plumbed through to `ResolvedConfig` but never consulted anywhere (no
  read-side DPoP replay-window check was ever wired to it), so the config
  surface promised behavior nothing implemented. `listChildren`'s WebDAV
  backend now defensively drops a child IRI that isn't actually same-origin
  (relevant if a forged `ldp:contains` triple, see #337, ever reaches the quad
  store) instead of slicing it into a bogus, non-`/`-rooted path — the
  same-origin check requires an exact match or a `/` immediately following the
  origin, not just a shared string prefix (`https://example.com.attacker.com/x`
  also starts with `https://example.com`'s characters, so a plain `startsWith`
  check was spoofable by a suffixed host).

  `@dwk/solid-pod` and `@dwk/remotestorage`: documented the existing
  `#getStore` per-isolate caching assumption (`maxInlineBytes` is taken from
  whichever request builds the store first, for the DO's lifetime) — no
  behavior change.

- 9c3f652: Close two TOCTOU windows where a containment/conflict invariant was checked
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

- Updated dependencies [0e65ce3]
- Updated dependencies [96cc2d3]
- Updated dependencies [3e505be]
- Updated dependencies [9c3f652]
- Updated dependencies [e6fee8e]
  - @dwk/webfinger@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.4
  - @dwk/store@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- b9362b1: Blob/document GET and HEAD responses now carry
  `X-Content-Type-Options: nosniff`. User-uploaded content is served back with
  a user-supplied content type, and pods/accounts can expose public resources
  without auth in front — without `nosniff` a mislabeled blob is a stored-XSS
  vector on shared-origin deployments.
- Updated dependencies [6d14fc3]
- Updated dependencies [f64ab9b]
  - @dwk/log@0.1.0-beta.3
  - @dwk/store@0.1.0-beta.3
  - @dwk/webfinger@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/log@0.1.0-beta.2
  - @dwk/store@0.1.0-beta.2
  - @dwk/webfinger@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1
  - @dwk/store@0.1.0-beta.1
  - @dwk/webfinger@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

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

- Updated dependencies [65cab2c]
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
- Updated dependencies [0c21c6b]
- Updated dependencies [b1e4180]
- Updated dependencies [ce0a851]
- Updated dependencies [f3332f2]
- Updated dependencies [4ab1926]
- Updated dependencies [ee7531f]
- Updated dependencies [dd82841]
- Updated dependencies [05ee6b2]
- Updated dependencies [ac7f340]
- Updated dependencies [d142211]
  - @dwk/store@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.0
  - @dwk/webfinger@0.1.0-beta.0
