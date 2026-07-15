# @dwk/remotestorage

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
