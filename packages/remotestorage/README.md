# `@dwk/remotestorage`

> remoteStorage (draft-dejong-remotestorage) personal data vault. Endpoint
> package + per-account Durable Object.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/remotestorage.md) for the full
requirements.

An [Unhosted](https://unhosted.org/)-style **remoteStorage** server: a per-user
document vault that "no-backend" web apps read and write over a plain HTTP
`GET`/`PUT`/`DELETE` API, scoped by OAuth 2.0 bearer tokens. It is a *competing*
personal-data protocol to Solid — simpler, document-oriented, **no RDF** — and
is filed here for completeness, **not** as a recommendation alongside
[`@dwk/solid-pod`](../solid-pod).

## Why it's here: one backing store, two protocols

[`@dwk/store`](../store) is **not** Solid-specific — it is a generic
`key → { rdf | blob }` pointer map over DO-SQLite + content-addressed,
copy-on-write R2 bodies with TOCTOU-free conditional writes and an orphan-outbox
GC. remoteStorage documents are simply its **blob tier**, so a remoteStorage
vault and a Solid Pod can ride the same library, the same R2 bucket, and the same
GC. The only library addition this package required is a single, **generic**
projection on the `Store` interface:

```ts
store.list(prefix); // every resource pointer whose key starts with `prefix`
```

`list(prefix)` ascribes no meaning to `/` or to "folders" — the folder model and
its aggregate ETags are derived in this package — so `@dwk/solid-pod` could use
the same projection to enumerate LDP container membership. Everything that makes
remoteStorage *remoteStorage* (the auth model and folder semantics) lives here.

## Usage

```ts
import {
  createRemoteStorage,
  createRemoteStorageGc,
  RemoteStorageObject,
} from "@dwk/remotestorage";

const storage = createRemoteStorage({
  baseUrl: "https://storage.example",
  // Built-in OAuth bearer (JWT) verification against the issuer's JWKS:
  issuer: "https://auth.example",
  jwksUri: "https://auth.example/jwks",
  // …or pass `authenticate(request)` to resolve opaque tokens (e.g. RFC 7662
  // introspection via @dwk/oauth) into `{ scopes }`.
});

// In your Worker, route the storage tree (default: `/<account>/<path…>`):
//   PUT  /alice/documents/note.txt
//   GET  /alice/documents/
//   GET  /alice/public/photos/cat.jpg   (no token needed)
export default { fetch: storage };
export { RemoteStorageObject };

// Bind a cron trigger to reclaim orphaned R2 bodies:
export const scheduled = createRemoteStorageGc({ baseUrl: "https://storage.example" });
```

**Bindings** (declared `Env` fragment, fail-loud if missing): a Durable Object
namespace `STORAGE` for the per-account class, an R2 bucket `BLOBS` (MAY be
shared with `@dwk/solid-pod`), and an optional D1 `GC_DB` the DO forwards orphan
keys into for the GC cron.

### Documents

- `PUT` a document → records its `Content-Type`, returns the new strong `ETag`
  (`201` on create, `200` on overwrite). Honors `If-Match` and `If-None-Match: *`
  (create-only), checked TOCTOU-free inside the store's write transaction (`412`
  on failure). Oversized bodies stream straight to R2, never buffered in the DO.
- `GET`/`HEAD` a document → body + `Content-Type` + `ETag`; `If-None-Match`
  yields `304`.
- `DELETE` a document → `200` with the deleted document's `ETag`; emptied parent
  folders simply vanish (they are virtual).
- A name that is already a folder (or whose ancestor is already a document) is a
  collision → **409**. A `PUT`/`DELETE` on a folder path (trailing slash) → **400**.

### Folders

`GET <path>/` returns the `application/ld+json`
[folder description](https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage-22)
(`http://remotestorage.io/spec/folder-description`): a map of immediate children
(documents with their `ETag` + `Content-Type`, subfolders with an aggregate
`ETag`) and a folder `ETag`. The folder ETag is a SHA-256 over a canonical
signature of **every descendant**, so it changes whenever anything in the subtree
does. An empty/absent folder still answers `200` with a stable ETag.

### Authorization (scopes)

Plain OAuth 2.0 **bearer** tokens (no DPoP). A token's `scope` claim is a
space-delimited list of `<module>:r` / `<module>:rw` entries, where the module is
a top-level folder name or `*` (the whole vault). A module scope covers both the
private tree `/<module>/…` and the public tree `/public/<module>/…`.

- **Reads** of `/public/` **documents** need no token (folders are never public).
- Every other access needs a scope at the required mode; a write without `rw` →
  **403**, a missing/invalid token on a private path → **401**.

### CORS

Permissive CORS on every response (draft §6) so browser apps on other origins
work: `OPTIONS` preflights are answered at the edge, and `ETag`/`Content-Type`/
`Content-Length` are exposed. Bearer tokens travel in `Authorization`, so no
credentialed CORS is needed.

### Discovery

`remoteStorageLink({ storageRoot, authEndpoint })` builds the WebFinger link a
connecting app reads to find a user's storage root and OAuth endpoint — drop it
into a [`@dwk/webfinger`](../webfinger) resource record.

## Design

Stateless front door (CORS + token verification + scope enforcement) over a
per-account Durable Object that is the single consistency authority (DO-SQLite +
R2 via `@dwk/store`). Authoritative state lives only in strongly-consistent
stores — **never KV**. The scope, folder, and CORS logic is pure and unit-tests
without a Workers runtime.

## Observability

Auth/authz events flow through the injected `@dwk/log` `Logger`/`Metrics` seams
(default no-op): `remotestorage.auth.accepted` / `.rejected` and
`remotestorage.scope.denied`. Fields are redacted to reason codes, HTTP
method/status, and a sanitized subject host — never tokens, scopes verbatim,
paths, or bodies.
