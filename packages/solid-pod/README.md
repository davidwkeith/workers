# `@dwk/solid-pod`

> Edge-native Solid Pod: LDP verbs, content negotiation, N3 Patch, WAC, notifications. Ships the per-pod Durable Object.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/solid-pod.md) for the full requirements.

An edge-native [Solid](https://solidproject.org/TR/protocol) Pod: a stateless
Worker front door over a per-pod **Durable Object** that is the consistency,
authorization, and notification authority, with **R2** for blob bodies. This is
the only `@dwk` package that ships a Durable Object. It composes the reusable
libraries [`@dwk/dpop`](../dpop) (edge DPoP validation), [`@dwk/rdf`](../rdf)
(Turtle/JSON-LD), [`@dwk/wac`](../wac) (access control), and
[`@dwk/store`](../store) (DO-SQLite quads + R2 copy-on-write blobs).

## What it does

- **LDP** — `GET / HEAD / OPTIONS / PUT / POST / PATCH / DELETE` with resource
  and basic-container semantics (`ldp:contains`).
- **Content negotiation** — Turtle and JSON-LD (plus the other Turtle-family
  types) on read, via `@dwk/rdf`.
- **N3 Patch / `application/sparql-update`** — `solid:where` is matched against
  the current graph with minimal (non-SPARQL) semantics: no exact single
  binding ⇒ **409**; `deletes` then `inserts` apply in one SQLite transaction.
- **Web Access Control** — walks to the nearest effective `.acl`
  (`acl:accessTo` / `acl:default`), evaluating `Read`/`Write`/`Append`/`Control`,
  agents, groups, `acl:agentClass foaf:Agent`, and `acl:origin` via `@dwk/wac`.
  `Append` authorizes insert-only patches; any delete requires `Write`. The pod
  `owner` always has full access (bootstraps `.acl` management).
- **Auth (Resource Server)** — DPoP-bound bearer tokens validated at the edge
  (issuer JWKS pinned by `kid`, header `typ: at+jwt`, `aud`/`exp`/`nbf`/`webid`,
  proof `htu`/`htm`/`ath`/`cnf.jkt`). Strict
  single-use `jti` replay is enforced in the DO for **writes**, pruned by expiry;
  reads do not consume a `jti` (a documented tradeoff).
- **Concurrency** — all writes funnel through the single-threaded DO; the
  `If-Match` / `If-None-Match` (create-only) check and the write are
  TOCTOU-free, evaluated inside the store's write transaction. Deleting a
  non-empty container is likewise rejected inside that transaction.
- **Oversized / binary bodies** — content-addressed R2 copy-on-write with an
  atomic DO pointer flip; orphaned keys are reclaimed by an out-of-band GC cron
  (`createSolidPodGc`), never by waking a DO.
- **Notifications** — Solid Notifications over WebSocket channels on the DO's
  hibernatable WebSockets (v1 channels carry the changed resource IRI only).

v1 is a **Resource Server only** (no OIDC OP) and runs **one Durable Object per
pod** (no sharding).

## Usage

```ts
import { createSolidPod, createSolidPodGc, SolidPodObject } from "@dwk/solid-pod";

const pod = createSolidPod({
  baseUrl: "https://pod.example",
  issuer: "https://issuer.example",
  jwksUri: "https://issuer.example/jwks",
  owner: "https://pod.example/profile/card#me",
});

const gc = createSolidPodGc({
  baseUrl: "https://pod.example",
  gcSafetyWindowMs: 300_000,
});

export default {
  fetch: pod,
  scheduled: gc,
};

// Bind the per-pod Durable Object class in your Worker.
export { SolidPodObject };
```

### Required bindings & `wrangler.toml`

```toml
compatibility_date = "2025-01-01"
# N3.js (via @dwk/rdf) uses Node's stream/buffer; the pod runs the parser in the DO.
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "POD"
class_name = "SolidPodObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SolidPodObject"]

[[r2_buckets]]
binding = "BLOBS"
bucket_name = "solid-pod-blobs"

# Optional: shared D1 table for out-of-band R2 garbage collection.
[[d1_databases]]
binding = "GC_DB"
database_name = "solid-pod-gc"

[triggers]
crons = ["*/5 * * * *"]
```

The `POD` (Durable Object) and `BLOBS` (R2) bindings are required; the handler
**fails loudly** at startup if either is missing. `GC_DB` (D1) is optional — when
bound, the DO forwards orphaned blob keys to it for the GC cron to reclaim.

## License

[ISC](../../LICENSE)
