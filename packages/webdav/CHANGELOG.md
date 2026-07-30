# @dwk/webdav

## 1.0.0-beta.2

### Minor Changes

- 185b555: Store WebDAV dead properties (RFC 4918 §4) in the pod DO's SQLite, closing the
  last litmus `props` failures (issue #467). `@dwk/webdav` gains `PropertyStore`
  and a `properties: DeadPropertyApi` port on the `WebdavBackend` seam; PROPPATCH
  now applies set/remove in document order and atomically (a protected live
  property fails 403 and drags the rest to 424, persisting nothing), and PROPFIND
  returns stored dead properties for named-prop, `allprop`, and `propname`
  requests — including no-namespace names, astral-plane values, and namespaced
  element values. `@dwk/solid-pod` wires the store through the pod DO: properties
  travel with COPY/MOVE and are dropped on DELETE from either door (WebDAV or
  Solid LDP).
- c3f1715: litmus conformance (issue #467): `basic`, `copymove`, and `locks` now pass
  16/16, 13/13, and 41/41 against the composed conformance target.

  - `MKCOL` with a trailing slash over an existing plain resource now 405s —
    neon's `ne_mkcol()` always appends a slash, so the previous un-slashed-only
    existence check let `mkcol_over_plain` create a collection alongside the
    plain resource.
  - WebDAV collection `DELETE` now acts as `Depth: infinity` (RFC 4918 §9.6.1),
    removing the whole subtree instead of refusing non-empty collections with
    409; the Solid door keeps its LDP refuse-on-non-empty semantics. litmus's
    own `begin` fixture depends on this to clear a previous run's leftovers.
  - The `If:` header is now parsed as the full (bounded) RFC 4918 §10.4 grammar
    — multiple OR'd lists, resource tags, `Not`, `DAV:no-lock` — and genuinely
    evaluated as a precondition (412 when no list holds, including a lock token
    that names no live lock), with lock enforcement counting only
    positively-named tokens as submitted.
  - Shared write locks: any number coexist, any one of their tokens admits a
    write, and an exclusive request against them conflicts.
  - The XML parser rejects the invalid `xmlns:prefix=""` declaration (400, litmus
    `propfind_invalid2`) and resolves a legal `xmlns=""` un-declaration to _no_
    namespace so no-namespace property names serialize legally.

  The `props` group still fails 8/30 cases, all on dead-property storage —
  excluded from v1 by spec §4 ("PROPPATCH of arbitrary dead properties is out
  of scope") — which is the remaining blocker for a fully green litmus run.

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

## 0.1.0-beta.2

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- a20ddcf: Fix a polynomial-regex-ReDoS finding (CodeQL `js/polynomial-redos`, alert #11)
  in `parseBasicAuthorization`: `/^basic\s+(.+)$/i` had `\s+` immediately
  followed by `(.+)$`, and since `\s` is a subset of what `.` matches, the two
  quantifiers were ambiguous about how to split the client-supplied
  `Authorization` header between them — the same shape already fixed in
  `@dwk/webmention`'s `parseLinkHeader` (#436). Replaced the combined regex with
  a plain `String.prototype.search`/`slice` split on the first whitespace run,
  which is unambiguous by construction. Behavior is unchanged, confirmed by the
  existing `parseBasicAuthorization` test suite.
- 8f14f4d: Address code-review follow-ups on the litmus conformance fixes:

  - `verifyAppPassword` now returns `false` instead of throwing when a
    record's `iterations` exceeds workerd's PBKDF2 ceiling, restoring its
    documented "never throws" contract for any record regardless of
    provenance (imported/migrated data, or anything minted outside
    `mintAppPassword`).
  - `COPY`/`MOVE` onto a destination whose immediate parent collection
    doesn't exist now `409`s instead of auto-vivifying it, closing the same
    RFC 4918 §9.8.5/§9.9.4 gap already fixed for `MKCOL`/`PUT`.

- 8f14f4d: Fix four RFC 4918 conformance bugs surfaced by a real litmus run against
  `conformance.dwk.io`:

  - `MKCOL`/`PUT` with a missing intermediate collection silently succeeded
    instead of `409 Conflict` (litmus `mkcol_no_parent`/`put_no_parent`) —
    the WebDAV door was calling into `@dwk/solid-pod`'s LDP write path, which
    auto-vivifies missing ancestor containers by design; the WebDAV backend
    now checks the immediate parent exists first and throws `ResourceConflict`
    when it doesn't, leaving the LDP door's own auto-vivify behavior untouched.
  - `MKCOL` over an existing plain resource silently succeeded instead of
    refusing (litmus `mkcol_over_plain`) — the existing-resource check only
    looked up the collection-path variant (with a trailing slash appended),
    missing a plain resource stored under the un-slashed name.
  - `DELETE` of a resource that never existed silently succeeded instead of
    `404` (litmus `delete_null`) — the router didn't check existence before
    calling into the backend's remove.

- e6eab17: Fix `MKCOL` silently succeeding over an existing plain resource when the
  request's percent-encoding hex case differs from the `PUT` that created it
  (litmus `mkcol_over_plain`, following `put_get_utf8_segment`). RFC 3986 §2.1
  treats `%e2` and `%E2` as the same octet, but the router resolved each
  request's path straight from `URL#pathname`, which copies an already-encoded
  triplet through verbatim rather than normalizing its case — so two requests
  naming the same UTF-8 segment with different encoder casing produced
  different path strings and missed each other in the backend's exact-match
  lookup. `pathOf` now uppercases every percent-encoded triplet before it's
  used anywhere downstream (backend calls, authorization, lock/precondition
  checks), so encoding-case no longer affects resource identity.
- c55669e: Fix `mintAppPassword` throwing `NotSupportedError` on every call in production:
  `DEFAULT_PBKDF2_ITERATIONS` was set to OWASP's 2023-recommended 600,000, but
  workerd's `crypto.subtle.deriveBits` hard-rejects PBKDF2 iteration counts above
  100,000. Capped the default at that runtime ceiling — still within OWASP's
  longstanding prior-generation minimum — so the owner-gated app-password mint
  endpoint (`createSolidPodWebdavCredentials`) actually works on Cloudflare
  Workers.

## 0.1.0-beta.1

### Patch Changes

- 36a3be1: Anchor the app-password `pathPrefix` scope on a path-segment boundary (#309).
  The check used a raw `startsWith`, so a credential scoped to `/photos` also
  authorized the sibling `/photos-private`. It now matches only the prefix
  collection itself or a true descendant (`path === base || path.startsWith(base +
"/")`), so a scoped credential can no longer reach adjacent same-prefix
  collections. (WAC still applies as the second gate.)
- 3e505be: `WEBDAV_PEPPER` is now actually mixed into the app-password hash (previously
  declared as a binding but never read, so it did nothing). `@dwk/solid-pod`
  now forwards it from its own `Env` into the `CredentialStore` it builds.

  Also fixed: a MKCOL request body sent without a `Content-Length` header
  (chunked transfer-encoding, whose length is unknown up front) previously
  defaulted to "length 0" and slipped past the RFC 4918 §9.3 unsupported-media
  check. The fix now reads (and discards) the first chunk of the body to check
  for actual bytes rather than inferring emptiness from headers alone, so a
  legitimate empty chunked-encoded MKCOL (a non-null body stream that simply
  yields no bytes) is no longer rejected alongside a real one.

## 0.1.0-beta.0

### Minor Changes

- a035da5: Implement the **`createWebdav` Class 2 verb router** and the authoritative
  DO-SQLite state it drives, building on the protocol core (#169).

  - **`createWebdav(config)`** — the RFC 4918 Class 2 request handler:
    `OPTIONS` (advertising `DAV: 1, 2` + `MS-Author-Via`), `PROPFIND`
    (`Depth: 0`/`1`, `infinity` refused), `PROPPATCH` (live/known-only),
    `MKCOL`, `GET`/`HEAD`, `PUT`, `DELETE`, `COPY`/`MOVE`, `LOCK`/`UNLOCK`. It
    generates the `multistatus`/`lockdiscovery` XML, infers content types and
    applies the optional OS-litter denylist, and renders backend errors as the
    right status (`412`/`409`/`423`).
  - **Auth bridge (§1)** — HTTPS-only HTTP Basic resolving an app password to a
    WebID, with `scope ∩ WAC` least privilege: the credential's scope is an upper
    bound, then the request is authorized exactly as a Solid request would be.
  - **`LockStore` (§2)** — exclusive write locks in DO SQLite:
    `opaquelocktoken:<uuid>` tokens, `Depth: 0` resource and **bounded**
    `Depth: infinity` collection locks (forbidden on the storage root and above a
    configurable depth), refresh/unlock, and opportunistic expiry pruning. A
    mutation of a locked resource without the matching `If:` token is `423 Locked`.
  - **`CredentialStore` (§1)** — app-password persistence (hash-only) with
    per-credential failed-attempt throttling and constant-time verification.
  - **`.acl`/`.meta` are `404` to every verb** and omitted from listings (§3).

  The protocol logic runs over an injected **`WebdavBackend`** seam (the explicit
  Durable Object boundary), so the router unit-tests at full DO-SQLite fidelity
  without standing up the whole pod. The concrete `SolidPodObject` adapter that
  resolves that seam onto the per-pod DO is the remaining increment.

- 7a475e2: Implement WebDAV **`COPY`/`MOVE`** on the pod's "second door" (#169) — the
  drag-drop and rename verbs OS file managers use — replacing the prior `501`.

  - `@dwk/webdav`: the router now `404`s a `COPY`/`MOVE` of a missing source and
    `409`s copying/moving a collection into its own subtree (RFC 4918 §9.8.5 /
    §9.9.4), ahead of the existing `Destination`/`Overwrite`/`Depth`/lock checks.
  - `@dwk/solid-pod`: the in-DO backend implements `copy`/`move` over `@dwk/store`.
    A data resource is copied verbatim — the content-addressed R2 blob makes a copy
    a near-free pointer; a container is recreated fresh with its `ldp:contains`
    rebuilt as children copy in (so membership reflects the new tree, not the
    source). `Depth: 0` copies only the collection; `MOVE` is copy-then-drop-source
    and is always `Depth: infinity`. Overwrite is delete-then-copy so no stale
    destination subtree lingers, and the storage root is immovable (`405`), as it
    is undeletable.

- 929513f: Add `@dwk/webdav` — a **WebDAV (RFC 4918, Class 2)** façade over a Solid pod, so
  the storage a user already owns can be mounted as a network drive by the file
  managers built into every major OS (Finder, Explorer, GNOME/KDE, iOS Files) with
  zero install. It is "one pod, a second door": WebDAV exposes the _same_ resources
  `@dwk/solid-pod` serves, not a parallel tree.

  This first beta ships the pure, Workers-runtime-free **protocol core**, all
  unit-tested:

  - **Bounded, XXE-safe XML** (`parseXml`, `escapeXml`) — a hand-rolled generator
    and recursive-descent parser for the small WebDAV bodies, with caps on size and
    nesting depth, `DOCTYPE`/external-entity rejection, UTF-8-only enforcement, and
    predefined-entity-only decoding.
  - **Scoped app passwords** (`mintAppPassword`, `verifyAppPassword`) — the auth
    bridge for OS clients that speak Basic only: a ≥128-bit secret bound to
    `(WebID, label, scope, expiry)`, stored only as a salted PBKDF2-HMAC-SHA-256
    hash and verified in constant time.
  - **`Content-Type` negotiation** and **`If` precondition header** parsing.

  The `createWebdav` request handler, Class 2 locking, and the per-pod Durable
  Object integration land in subsequent increments — see
  `spec/packages/webdav.md` for the four load-bearing decisions. Tracked in #169.

### Patch Changes

- fd5a818: Tighten the Class 2 verb router's RFC 4918 conformance ahead of the hosted
  litmus run (#169), closing six gaps a spec review surfaced:

  - **`If:` header strictness (§10.4).** A header outside the supported subset
    (tagged lists, `Not`, multiple state tokens) is now answered `400` instead of
    being silently treated as "no token" — making good on the spec §4 promise to
    reject rather than guess, and closing a fail-_open_ path where a dropped
    conditional could let an unintended write through.
  - **`If:` `[etag]` is now enforced (§10.4.2).** The header's ETag production is
    mapped onto the TOCTOU-free `If-Match` precondition (an explicit `If-Match`
    still wins) instead of being parsed and ignored.
  - **`Allow` on every `405` (RFC 7231 §6.5.5).** Unknown methods, `PUT` on a
    collection, and a duplicate `MKCOL` now carry the mandatory `Allow` header.
  - **`PROPFIND Depth: infinity`** returns the `<DAV:propfind-finite-depth/>`
    precondition marker (§9.1) instead of a plain-text `403`.
  - **`423 Locked`** on `DELETE`/`MOVE`/`PROPPATCH` now carries the
    `<DAV:lock-token-submitted>` body (§16), as `PUT` already did, so clients learn
    which token to resubmit.
  - **Cross-server `COPY`/`MOVE`** `Destination` is answered `502` (§9.8.5/§9.9)
    rather than `400`.

  Per-member `207 Multi-Status` failure reporting for collection
  `DELETE`/`COPY`/`MOVE` remains a documented v1 simplification.
