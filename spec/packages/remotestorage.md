# `@dwk/remotestorage`

| | |
|---|---|
| **Type** | endpoint + Durable Object |
| **Ships a DO?** | **yes** — a per-account Durable Object (reuses [`@dwk/store`](store.md)) |
| **Standard** | [remoteStorage](https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage-22) (draft-dejong-remotestorage) |
| **Status** | proposed (honorable mention) — tracked in [#105](https://github.com/davidwkeith/workers/issues/105) |

An [Unhosted](https://unhosted.org/)-style **remoteStorage** server: a
per-user document vault that "no-backend" web apps read and write over a simple
HTTP `GET`/`PUT`/`DELETE` API, scoped by OAuth bearer tokens. It is a *competing*
personal-data protocol to Solid — simpler, document-oriented, no RDF — so this
is filed for completeness, **not** as a recommendation alongside
[`@dwk/solid-pod`](solid-pod.md). Its value here is almost entirely the question
below: it can ride on the **same backing store** the Pod already uses.

## Can we use the same backing store for Solid and remoteStorage? — **Yes.**

[`@dwk/store`](store.md) is **not** Solid-specific. It is a generic
`key → { rdf | blob }` pointer map over DO-SQLite + content-addressed,
copy-on-write R2 bodies, with TOCTOU-free `If-Match` / `If-None-Match` writes and
the orphan-outbox GC path. Every property remoteStorage needs is already there:

| remoteStorage requirement | `@dwk/store` mapping |
|---|---|
| A **document** = opaque bytes + Content-Type + ETag | the **blob tier** (`putBlob` / `readBlob` / `delete`) — already records per-resource Content-Type + a fresh opaque ETag |
| **Conditional `PUT`** (`If-Match`, `If-None-Match: *` for create-only) | already TOCTOU-free in-transaction (`WriteOptions.ifMatch` / `ifNoneMatch`) |
| **Strong consistency** for a user's vault | single-threaded per-account DO + SQLite + R2 — never KV |
| Large/binary documents | the size-routing + streamed-to-R2 blob path (never buffered in the DO) |
| Storage efficiency | content-addressed dedup is a free win for identical bytes |

So Solid resources (RDF, `kind='rdf'`) and remoteStorage documents
(`kind='blob'`) coexist in **one `resources` table** keyed by opaque path, in
the **same R2 bucket**, under the **same GC**. Two protocol facades, one storage
authority.

### What the store does *not* yet give us (the real work)

Two things remoteStorage needs that are **endpoint-layer**, not Solid-specific —
and one of them implies a single, protocol-agnostic addition to the `Store`
interface:

1. **Folder listings + folder ETags.** `GET <folder>/` MUST return a JSON listing
   of immediate children with their ETags, and a folder's ETag MUST change when
   **any descendant** changes (draft §A). The store keys are opaque strings with
   no native prefix-enumeration and no ancestor-ETag propagation. This needs a
   small `list(prefix)` projection on the `Store` interface
   (`SELECT … WHERE key LIKE prefix || '%'`, scoped to immediate children) plus
   folder-ETag derivation in the handler. Crucially this is **generic** —
   `@dwk/solid-pod` can use the same `list(prefix)` to enumerate LDP container
   membership instead of maintaining `ldp:contains` triples — so it does **not**
   taint the store with remoteStorage assumptions.
2. **Auth model divergence.** remoteStorage uses **plain OAuth 2.0 bearer tokens
   with per-top-level-folder scopes** (`<module>:r` / `<module>:rw`) and a public
   `/public/` tree — **not** DPoP + WAC. That difference lives entirely in this
   endpoint package (reusing [`@dwk/oauth`](oauth.md) for the implicit-grant /
   token surface), never in the store.

### One DO or two?

Because the store keys are just opaque paths and the two protocols use disjoint
top-level namespaces, a user **may** run Solid and remoteStorage as two facades
over **one** per-account DO + `@dwk/store` instance (a single consistency domain,
shared ETags/GC/R2), **or** as separate DOs that each instantiate `@dwk/store`
the same way `@dwk/solid-pod` does. Recommended default: a **separate thin
`@dwk/remotestorage` DO that reuses `@dwk/store`** — "same backing store" means
the same library + storage primitives, not forced co-tenancy — with co-tenancy
in one DO offered as an opt-in for users who want a single unified vault.

## Functional requirements

- Export `createRemoteStorage(config)` returning the handler, mountable under a
  path prefix; export the per-account DO class.
- **Documents:** `GET` / `PUT` / `DELETE` on document paths; `PUT` records the
  request `Content-Type`, returns the new ETag; honor `If-Match` / `If-None-Match`.
- **Folders:** `GET <path>/` returns the `application/ld+json`
  (`http://remotestorage.io/spec/folder-description`) listing of immediate
  children → `{ ETag }`, with the aggregate folder ETag.
- **Auth:** OAuth 2.0 bearer tokens (via [`@dwk/oauth`](oauth.md)); enforce
  per-module read vs read-write **scopes**; allow unauthenticated reads under
  `/public/` and authenticated-only writes everywhere.
- **CORS:** permissive CORS per the draft so browser apps on other origins can
  use the store.
- **Discovery:** advertise the storage root + OAuth endpoint via
  [`@dwk/webfinger`](webfinger.md) (`rel` = the remoteStorage draft URI).

## Design constraints

- Authoritative state in DO-SQLite + R2 only — **never KV** (a lost document or
  stale ETag is a correctness bug).
- Reuse [`@dwk/store`](store.md) unchanged except for the generic `list(prefix)`
  addition above; do **not** fork a parallel storage layer.
- Reuse [`@dwk/oauth`](oauth.md) and [`@dwk/webfinger`](webfinger.md) rather than
  re-implementing token issuance or discovery.

## Bindings (declared `Env` fragment)

- **Durable Object namespace** for the per-account class.
- **R2 bucket** for document bodies (MAY be the same bucket as `@dwk/solid-pod`).
- A **cron trigger** for R2 GC (shared with the store's GC path).
- OAuth issuer / token config.

## Config

- `baseUrl` / account identity root.
- OAuth issuer + accepted scopes / module list.
- DO-cell size threshold (inherited from `@dwk/store`).
- Whether to co-tenant in the `@dwk/solid-pod` DO or run a dedicated DO.

## Conformance / testing

- The [remoteStorage test suite](https://github.com/remotestorage/api-test-suite)
  and interop with `remotestorage.js` apps; colocated unit tests over the
  document/folder semantics, scope enforcement, and conditional writes. See
  [conformance-and-testing.md](../conformance-and-testing.md).
