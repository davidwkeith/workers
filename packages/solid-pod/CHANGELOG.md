# @dwk/solid-pod

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
