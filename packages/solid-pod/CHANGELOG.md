# @dwk/solid-pod

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/calendar@1.0.0-beta.1
  - @dwk/dpop@1.0.0-beta.1
  - @dwk/ldn@1.0.0-beta.1
  - @dwk/log@1.0.0-beta.1
  - @dwk/mcp@1.0.0-beta.1
  - @dwk/rdf@1.0.0-beta.1
  - @dwk/safe-fetch@1.0.0-beta.1
  - @dwk/store@1.0.0-beta.1
  - @dwk/wac@1.0.0-beta.1
  - @dwk/webdav@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
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

- Updated dependencies [dc59912]
- Updated dependencies [4cd36af]
- Updated dependencies [a20ddcf]
- Updated dependencies [8f14f4d]
- Updated dependencies [8f14f4d]
- Updated dependencies [e6eab17]
- Updated dependencies [c55669e]
  - @dwk/dpop@0.1.0-beta.4
  - @dwk/calendar@0.1.0-beta.3
  - @dwk/ldn@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.5
  - @dwk/mcp@0.1.0-beta.1
  - @dwk/rdf@0.1.0-beta.4
  - @dwk/safe-fetch@0.1.0-beta.4
  - @dwk/store@0.1.0-beta.5
  - @dwk/wac@0.1.0-beta.4
  - @dwk/webdav@0.1.0-beta.2

## 0.1.0-beta.4

### Minor Changes

- 3a60a5c: Add `createSolidPodMcpTools` (#262): a `@dwk/mcp` tool contribution exposing
  `solid_pod_read` and `solid_pod_write`. Both dispatch through the same
  internal `Request` shape `createSolidPod`'s HTTP door sends to the per-pod
  `SolidPodObject` Durable Object, so the pod's existing WAC evaluation is a
  second, resource-level gate beneath the MCP scope check — a caller's WebID
  (the MCP token's resolved `subject`) still has to be granted access under
  the pod's `.acl`s. `solid_pod_write` supports a `dryRun` preview and refuses
  outright when the caller has no resolved subject, since the pod's write
  path requires proof of an authenticated identity. `forwardedConfig` is now
  exported from `handler.ts`, and `resolveConfig`/`ResolvedConfig` from
  `index.ts`, so the tool factory can build the same wire format without
  duplicating it. `solid_pod_read` rejects a protocol-relative path (a
  leading `//`, which `new URL` would otherwise resolve off-origin) and caps
  the response body via `@dwk/safe-fetch`'s `readBodyCapped` (2 MB) so a
  large pod resource can't be read into unbounded Worker memory through an
  LLM-bound tool call.

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

- 52c3f4f: Fix a container `PUT` persisting a client-forged `ldp:contains` triple. A
  container's containment listing is entirely server-managed — clients never
  legitimately send it — but `#putRdf` wrote every parsed body quad verbatim, so
  a Turtle/JSON-LD container `PUT` that included a forged `ldp:contains` triple
  had it persisted alongside the genuine, atomically-preserved containment. A
  forged triple pointing at a resource that exists (or is later created)
  elsewhere would then surface as a phantom membership in the container
  listing. The container branch of `#putRdf` now strips any `ldp:contains`
  quad whose subject is the container IRI from the client-supplied quads before
  writing, since real containment is already preserved via `preserveWhere`.
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

- 3e505be: `evaluateAccess`'s second parameter is now a single `AclResource` (the
  effective ACL) instead of an `AclResource[]` chain of which only the first
  entry was ever consulted — the array shape implied a multi-entry walk that
  never happened. Callers passing `[acl]` now pass `acl` directly.

  Also documents (with a regression test) that a subject granting
  `acl:mode`/`acl:agent`/etc. without an explicit `rdf:type acl:Authorization`
  triple is not treated as an authorization — a conscious, fail-closed choice,
  not an oversight.

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

- Updated dependencies [0e65ce3]
- Updated dependencies [36a3be1]
- Updated dependencies [3e505be]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
- Updated dependencies [9c3f652]
- Updated dependencies [e6fee8e]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/calendar@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.4
  - @dwk/rdf@0.1.0-beta.3
  - @dwk/store@0.1.0-beta.4
  - @dwk/wac@0.1.0-beta.3
  - @dwk/webdav@0.1.0-beta.1
  - @dwk/ldn@0.1.0-beta.3

## 0.1.0-beta.3

### Minor Changes

- 87c2dd8: Add `calendarEventToQuads(event, subjectIri)` / `quadsToCalendarEvent(quads,
subjectIri)` — the Solid-specific adapter between the canonical `CalendarEvent`
  model in [`@dwk/calendar`](https://github.com/davidwkeith/workers/tree/main/packages/calendar)
  and RDF, so calendar events live as ordinary WAC-gated LDP resources in a pod.
  [schema.org](https://schema.org/Event) is the canonical vocabulary
  (`schema:Event` + `startDate`/`endDate`/`location`/`keywords`/`eventStatus`/…),
  JSON-LD-native and what Solid clients expect; the adapter emits and reads it via
  the flat `StoredQuad` shape the DO quad store and `@dwk/rdf` already use, so a
  client serializes with `@dwk/rdf` and PUTs Turtle/JSON-LD through the existing
  LDP surface, then reads it back into the same record. `uid` round-trips as
  `schema:identifier`; `start`/`end` carry `xsd:date`/`xsd:dateTime`. The same
  event is thus a view shared with the `.ics` `VEVENT`, JSCalendar, `h-event`, and
  AS2 `Event` serializations. The adapter lives here, not in the cross-standard
  `@dwk/calendar` lib, which must stay free of Solid/RDF assumptions. Part of the
  calendar/events work (#172, epic #167).
- ca19532: Wire the `@dwk/webdav` Class 2 façade onto the live per-pod `SolidPodObject` —
  the "second door" (#169). The pod's storage is now mountable as a network drive
  by OS file managers over HTTP Basic app-passwords, sharing one consistency
  domain with the Solid door.

  - **`createSolidPodWebdav(config)`** — a stateless WebDAV front door that
    resolves the per-pod DO and forwards verbs (with an `x-solid-webdav` marker
    and the raw `Authorization` header) to it.
  - **In-DO integration** — `SolidPodObject` now hosts the `LockStore` and
    `CredentialStore` in its own SQLite and runs the `createWebdav` router over an
    in-DO `WebdavBackend` adapter built on the pod's `@dwk/store` + WAC. App
    passwords are verified in the DO; effective access is `scope ∩ WAC`. PUT/MKCOL
    reuse the exact RDF-vs-blob routing and `ldp:contains` containment as Solid
    writes (a `.ttl` written from Finder is a first-class quad resource), and the
    storage root stays undeletable. Lock state lives beside the Solid write path,
    so a WebDAV `LOCK` blocks an unkeyed Solid or WebDAV write alike (`423`).
  - The shared write path is refactored into a request-independent
    `#writeResolvedBody` so both doors classify and store bodies identically.

  `COPY`/`MOVE` (currently `501`), the owner-gated app-password mint/revoke
  endpoint, and the hosted litmus run land in a follow-up increment.

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

- 99a01c4: Add the **owner-gated WebDAV app-password endpoint**
  (`createSolidPodWebdavCredentials`) so users can mint, list, and revoke the
  Basic-auth credentials the WebDAV door consumes (#169) — instead of seeding them
  out of band.

  Issuance is a resource-server concern guarded by the pod's existing DPoP-bound
  **owner** token (distinct from the Basic-auth data door): the Solid front door
  authenticates at the edge, then the per-pod `SolidPodObject` re-checks ownership
  and serves `POST` (mint — the plaintext secret is returned exactly once), `GET`
  (list the owner's credentials, metadata only — never the hash or secret), and
  `DELETE ?id=…` (revoke; an owner may only revoke a credential bound to their own
  WebID). Credentials bind to the authenticated owner's WebID and verify on the
  same per-pod `CredentialStore` the data door reads.

### Patch Changes

- 7725b36: Protect the storage root container from deletion (Solid
  `#server-delete-protect-root-container`). A `DELETE` against the storage root is
  now refused `405` ahead of any authorization check, and the advertised `Allow`
  (on `OPTIONS` and successful responses) omits `DELETE` for that one container.
  The storage root is derived from the pod `baseUrl`'s pathname as a container
  (`/` for an origin-root pod) and forwarded to the Durable Object alongside the
  other resolved config.
- b9362b1: Blob/document GET and HEAD responses now carry
  `X-Content-Type-Options: nosniff`. User-uploaded content is served back with
  a user-supplied content type, and pods/accounts can expose public resources
  without auth in front — without `nosniff` a mislabeled blob is a stored-XSS
  vector on shared-origin deployments.
- f64ab9b: Track per-resource **byte size** and **last-modified time** in `@dwk/store` and
  surface them on `ResourceMeta` (`size`, `modifiedAt`), so consumers get real
  file metadata without an extra read (#169).

  - `@dwk/store`: a `size` column is added to the `resources` table (with an
    idempotent migration for pods predating it) and recorded on every write — the
    blob write path measures the R2 object's byte size, and inline RDF records its
    source byte length via a new optional `WriteOptions.size`. `mtime` reuses the
    existing `updated_at`. `head()` and `list()` now return both. Size is `0` for
    resources with no canonical byte body (e.g. containers).
  - `@dwk/solid-pod`: the WebDAV adapter drops its `getlastmodified` stand-in and
    its extra `readBlob`-for-size, reporting the store's real `size`/`modifiedAt`
    in PROPFIND/HEAD/GET. A stable, accurate `getlastmodified` no longer makes OS
    clients see a perpetually-changing file, and a `Depth: 1` listing is a pure
    SQLite scan with no per-child R2 round-trip.

- Updated dependencies [fc4f47b]
- Updated dependencies [6d14fc3]
- Updated dependencies [f64ab9b]
- Updated dependencies [a035da5]
- Updated dependencies [7a475e2]
- Updated dependencies [929513f]
- Updated dependencies [fd5a818]
  - @dwk/calendar@0.1.0-beta.1
  - @dwk/dpop@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.3
  - @dwk/store@0.1.0-beta.3
  - @dwk/webdav@0.1.0-beta.0

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/dpop@0.1.0-beta.2
  - @dwk/ldn@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.2
  - @dwk/rdf@0.1.0-beta.2
  - @dwk/store@0.1.0-beta.2
  - @dwk/wac@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/dpop@0.1.0-beta.1
  - @dwk/ldn@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.1
  - @dwk/rdf@0.1.0-beta.1
  - @dwk/store@0.1.0-beta.1
  - @dwk/wac@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 08cf029: Adopt the injectable `@dwk/log` logging and metrics seams in the remaining
  endpoint packages, so auth/authz decisions and validation rejections are no
  longer silently swallowed (see `spec/observability.md`). Each package now depends
  on `@dwk/log`, accepts an optional `logger` and `metrics` in its config
  (defaulting to no-ops), owns an exported event taxonomy, and passes the same
  `(event, fields)` to both seams. Redaction follows the cross-cutting policy:
  only machine-readable reason codes, hosts (`hostFromUrl`), HTTP method/status,
  and scopes are recorded — never tokens, codes, proofs, or bodies.
  - **`@dwk/indieauth`** (`IndieAuthLogEvent`): authorization rejections by reason
    (`client_id_invalid`, `redirect_uri_not_permitted`, `pkce_required`, …), code
    issuance, token issuance, token-endpoint rejections by reason
    (`invalid_grant`, `pkce_failed`, `dpop_invalid`, …), and revocations.
  - **`@dwk/micropub`** (`MicropubLogEvent`): authorization rejections by error
    code, validation rejections by reason (`invalid_body`, `media_too_large`,
    `missing_type`, …), action completions by verb, and media stored.
  - **`@dwk/solid-pod`** (`SolidPodLogEvent`): edge-authentication rejections by
    reason and acceptances are emitted by the stateless front door. Because a
    Durable Object cannot receive the injected seams across the isolate boundary,
    the DO signals its WAC denials, anonymous-write refusals, and DPoP replay
    rejections back to the front door via an internal `x-solid-outcome` response
    header; the front door — the composition boundary where the seams are wired —
    emits the matching events and strips the header before replying to the client.

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.
- 7cb9c05: Add `@dwk/ldn` — RDF-only, protocol-agnostic Linked Data Notifications (W3C LDN)
  primitives, and wire `@dwk/solid-pod` and `@dwk/activitypub` to consume them
  (resolves the "extract / leave / close" decision in #63 as **extract**).
  - **`@dwk/ldn`** implements the three LDN roles as plain-data functions over
    `@dwk/rdf`'s flat `StoredQuad` representation, with no Cloudflare bindings, no
    transport, and no Solid/WAC assumptions: **discovery** (`inboxLinkHeader` /
    `inboxTriple` to advertise, `parseInboxLinks` / `discoverInboxIris` to find an
    inbox), **receiver** (`parseNotification` validates a posted RDF notification,
    throwing a `NotificationProblem` carrying the HTTP status — `415` for a non-RDF
    media type, `400` for an unparseable/empty body), and **consumer**
    (`inboxListingQuads` / `listInboxMembers` for the `ldp:Container` +
    `ldp:contains` listing). The discovery helpers depend on `@dwk/rdf` for types
    only, so they are reachable as the n3-free entry point `@dwk/ldn/discovery`
    that a Workers-runtime consumer imports without pulling in the RDF parser.
  - **`@dwk/solid-pod`** now surfaces any `ldp:inbox` a resource's graph declares
    as a `Link rel="http://www.w3.org/ns/ldp#inbox"` header on `GET`/`HEAD`,
    implementing LDN discovery on top of its existing LDP container receiver.
  - **`@dwk/activitypub`** advertises the actor's inbox via the same LDN `Link`
    header on the actor document, so a plain LDN sender can discover it without
    parsing the ActivityStreams body.

- aa6a599: Implement the edge-native Solid Pod, replacing the `501` stub. A stateless
  Worker front door (`createSolidPod`) authenticates DPoP-bound bearer tokens at
  the edge and funnels everything through the per-pod `SolidPodObject` Durable
  Object, the consistency/authz/notification authority.
  - **LDP**: `GET/HEAD/OPTIONS/PUT/POST/PATCH/DELETE` with resource and basic-
    container (`ldp:contains`) semantics.
  - **Content negotiation**: Turtle and JSON-LD (and the Turtle family) on read
    via `@dwk/rdf`.
  - **N3 Patch / `application/sparql-update`**: `solid:where` matched with minimal
    (non-SPARQL) semantics — no exact single binding ⇒ `409`; `deletes` then
    `inserts` in one SQLite transaction.
  - **WAC** via `@dwk/wac`: nearest effective `.acl`
    (`acl:accessTo`/`acl:default`), `Read`/`Write`/`Append`/`Control`, agents,
    `acl:agentClass foaf:Agent`, `acl:origin`; `Append` authorizes insert-only
    patches. A configurable pod `owner` always has full access.
  - **Auth (Resource Server)**: issuer-JWKS token validation (`aud`/`exp`/`webid`)
    plus DPoP proof binding (`htu`/`htm`/`ath`/`cnf.jkt`) via `@dwk/dpop`; strict
    single-use `jti` replay enforced in the DO for writes, pruned by expiry.
  - **Concurrency**: TOCTOU-free `If-Match`/ETag writes through the single-threaded
    DO via `@dwk/store`.
  - **Blobs**: oversized/binary bodies use R2 copy-on-write with an atomic pointer
    flip; `createSolidPodGc` is a cron handler that reclaims orphaned objects out
    of band, never waking a DO.
  - **Notifications**: Solid Notifications over the DO's hibernatable WebSockets.

  v1 is a Resource Server only (no OIDC OP) and runs one Durable Object per pod
  (no sharding). Requires the `nodejs_compat` flag (N3.js uses Node stream/buffer).

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

- 9224fd7: Fix JSON-LD ⇄ RDF conformance bugs in `@dwk/rdf` (#38):
  - **Relative IRIs are dropped, not emitted.** A relative `@id`/IRI that no
    `@base`/`base` resolves to an absolute IRI is now dropped (in subject, `@id`
    coercion, `@type`, and predicate position) rather than minting an invalid
    `NamedNode`.
  - **Canonical `xsd:double`.** Doubles now serialize in canonical lexical form
    (mantissa with a decimal point, no trailing zeros, uppercase `E`, signed
    exponent — e.g. `1.0E2`, `1.0E-7`); numbers with magnitude `>= 1e21` map to
    `xsd:double`, and an explicit `xsd:double` `@type` forces the double form.
  - **`@value: null` produces no triple** instead of a bogus `"null"` literal.
  - **`@list` is reconstructed on serialize**, collapsing well-formed
    `rdf:first`/`rdf:rest`/`rdf:nil` chains back into `@list`. (An empty list is
    `rdf:nil`, which the JSON-LD data model cannot distinguish from a literal
    `rdf:nil` reference — documented.)
  - **`application/json` is no longer treated as RDF.** JSON-LD's media type is
    `application/ld+json`; the `application/json` alias is removed from the RDF
    media-type registry so arbitrary JSON bodies can't be misparsed as a graph on
    write/PATCH. A read-only `application/json` → JSON-LD convenience remains as an
    explicit opt-in in `@dwk/solid-pod` content negotiation.

- 8ab47a2: Replace fragile regexes with plain string handling where it is clearer and
  safer:
  - `@dwk/webmention`: add a shared `isHtmlContentType` helper that compares the
    `Content-Type` essence (the part before any `;` parameters) instead of a
    loose `text/html|application/xhtml+xml` substring match, and use it in both
    source verification and endpoint discovery. The `javascript:`/`file:` guard
    in the sender now compares `URL.protocol` directly rather than via regex.
  - `@dwk/solid-pod`: the access-token `typ` normalization strips the
    `application/` prefix with `startsWith`/`slice`. The LDP container `Link`
    detection now ties the `rel="type"` parameter to the container-type URI
    within the same link-value, so a stray `rel="type"` on one link can no longer
    combine with an unrelated container URI on another to falsely mark a POST as
    a container.

- 022cd86: Close three access-token JWT validation gaps in `@dwk/solid-pod` (#35):
  - **Enforce `typ: at+jwt`.** The Resource Server now requires the access-token
    header `typ` to be `at+jwt` (case-insensitive, tolerating the
    `application/at+jwt` media-type form), so an ID token or other issuer-signed
    JWT sharing the same `iss`/`aud`/`webid` cannot be replayed as an access token
    (token-type confusion). Configurable via the new `accessTokenType` option; set
    to `null` to opt out for issuers that omit `typ`.
  - **Pin `kid`.** When a token names a `kid` that matches no JWKS key,
    `verifyJwtSignature` now fails instead of falling back to other
    alg-compatible keys, restoring `kid` pinning. Tokens with no `kid` still try
    every compatible key.
  - **Validate `nbf`.** A token presented before its `nbf` not-before time is now
    rejected (`token_not_yet_valid`).

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

- cf19d87: Fix a cluster of LDP / content-negotiation conformance gaps (issue #37):
  - **`406 Not Acceptable` is now returned** when an `Accept` header is present but
    lists nothing the server can serialize (e.g. `Accept: application/pdf` on an
    RDF resource). `negotiateMediaType` distinguishes "no `Accept` / `*/*`"
    (→ Turtle default) from "present but unacceptable" (→ `null`, mapped to `406`);
    it previously fell through to Turtle for any unmatched type.
  - **Auxiliary resources no longer leak through container listings.** `.acl` and
    `.meta` documents are no longer added to a container's `ldp:contains`, so a
    requester with container `Read` can no longer discover the existence/paths of
    ACL documents.
  - **`If-None-Match` now honors lists and weak validators** per RFC 7232 §3.2.
    A header is parsed as a comma-separated list and compared with the weak
    comparison function (the `W/` prefix is ignored), so `If-None-Match: "a", "b"`
    and `W/"…"` correctly produce `304`, restoring conditional-GET caching.
  - **`Accept-Post` advertises concrete types** (`text/turtle, application/ld+json,
*/*`) instead of a bare `*/*`.

- 65a0528: Bound the N3 Patch `solid:where` solver against CPU exhaustion (#36). The
  conjunctive matcher built the full cartesian product of candidate bindings
  (`N^k` for `k` all-variable `where` triples against an `N`-triple resource)
  before checking for a single bind. Because N3 Patch runs inside the
  single-threaded per-pod Durable Object, an authenticated `Append`/`Write`
  client could submit a crafted patch that blew the CPU budget and stalled the
  entire pod (DoS).

  `solve` now caps the `where` triple count and the total candidate-match work
  regardless of resource size, throwing `where_too_complex` (surfaced as `400`)
  when either bound is exceeded, and short-circuits as soon as a second solution
  appears — it only needs to distinguish "no bind", "exactly one bind", and
  "ambiguous", not enumerate every solution.

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

- fc3c35b: Fix a privilege escalation where a container `POST` with a `Slug` ending in a
  reserved auxiliary suffix (`.acl`/`.meta`) could mint that auxiliary resource.
  A `POST` is only authorized for `Append`/`Write` on the parent container, but
  the sanitized `Slug` preserved `.`, so `Slug: evil.acl` produced the ACL
  document `/c/evil.acl` — letting an `Append`-only agent write an ACL that WAC
  reserves for `acl:Control`. `childKey` now treats a `Slug` that would yield a
  reserved auxiliary key as unusable and falls back to a random name, so a
  container `POST` can never create an `.acl`/`.meta`. Adds the
  `hasReservedAuxiliarySuffix` helper.
- 44e82b5: Fix Solid Protocol / WAC conformance gaps in the resource handler. Emit the
  `WAC-Allow` header on `GET`/`HEAD` responses advertising the authenticated
  agent's and the public's granted modes (WAC §5.3.5), with `write` implying
  `append`. Return `422` for N3 Patch document-constraint violations as Solid
  §5.3.1 mandates — a missing `solid:InsertDeletePatch` type triple, blank nodes
  in the inserts/deletes formulae, more than one `solid:where`/`inserts`/`deletes`
  statement, and template variables not bound by `where` are now rejected with
  `422` instead of `400`/`409`, while `409` is reserved for binding/state
  outcomes (`no_match`/`ambiguous_match`/`delete_not_found`). Add the `Allow`
  header to successful responses (Solid `#server-allow-methods`).
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

- Updated dependencies [cdda653]
- Updated dependencies [171749e]
- Updated dependencies [28a1693]
- Updated dependencies [65cab2c]
- Updated dependencies [78f1a6f]
- Updated dependencies [7cb9c05]
- Updated dependencies [bf285a1]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
- Updated dependencies [3a806d9]
- Updated dependencies [9224fd7]
- Updated dependencies [0c21c6b]
- Updated dependencies [b1e4180]
- Updated dependencies [ce0a851]
- Updated dependencies [f3332f2]
- Updated dependencies [4ab1926]
- Updated dependencies [ee7531f]
- Updated dependencies [dd82841]
- Updated dependencies [05ee6b2]
- Updated dependencies [0253558]
- Updated dependencies [ec90b5f]
- Updated dependencies [a3fa4ff]
  - @dwk/dpop@0.1.0-beta.0
  - @dwk/rdf@0.1.0-beta.0
  - @dwk/wac@0.1.0-beta.0
  - @dwk/store@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.0
  - @dwk/ldn@0.1.0-beta.0
