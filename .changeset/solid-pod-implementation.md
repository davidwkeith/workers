---
"@dwk/solid-pod": minor
---

Implement the edge-native Solid Pod, replacing the `501` stub. A stateless
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
