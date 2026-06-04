# `@dwk/solid-pod`

| | |
|---|---|
| **Type** | endpoint + Durable Object |
| **Ships a DO?** | **yes** — the per-pod Durable Object class |
| **Standard** | [Solid Protocol](https://solidproject.org/TR/protocol) |

The hard one. An edge-native Solid Pod: a stateless Worker front door over a
per-pod Durable Object that is the consistency, authz, and notification
authority, with R2 for blob bodies. This is the **only** package that ships a
Durable Object.

## Functional requirements

### LDP resource & container model

- Support `GET / HEAD / OPTIONS / PUT / POST / PATCH / DELETE`.
- Full LDP resource + container semantics.

### RDF content negotiation

- Content-negotiate **Turtle** and **JSON-LD** at minimum on read (via
  [`@dwk/rdf`](rdf.md)).
- Resources are stored as **triples in the DO quad store** (via
  [`@dwk/store`](store.md)).

### N3 Patch / `application/sparql-update`

- Parse the patch, then:
  1. Evaluate `solid:where` against the current graph. **No exact bind → 409.**
  2. Apply `deletes`, then `inserts`, **in one SQLite transaction.**
- Minimal match semantics only — this is **not** a SPARQL engine.
- **Bounded solver (DoS guard).** The conjunctive `where` matcher runs inside
  the single-threaded per-pod DO, so its cost is capped: the pattern may have at
  most a small number of triples, and the total candidate-match work across the
  pattern is capped regardless of resource size. A pattern that exceeds either
  bound (e.g. several all-variable `where` triples that build an `N^k`
  cartesian product) is rejected with **`400`** rather than evaluated. The
  solver only distinguishes "no bind", "exactly one bind", and "more than one
  bind", so it short-circuits once a second solution appears.

### WAC (Web Access Control)

- Walk to the nearest effective `.acl` (honoring `acl:default` on an ancestor).
- Evaluate `acl:Read` / `acl:Write` / `acl:Append` / `acl:Control`, groups,
  `acl:agentClass foaf:Agent`, and `acl:origin`.
- **`Append` authorizes insert-only patches; any delete requires `Write`.**
- Evaluation logic lives in [`@dwk/wac`](wac.md).

### Auth (Resource Server)

- **DPoP-bound bearer tokens**, validated at the Worker edge: issuer JWKS,
  `aud` / `exp` / `webid`, and proof `htu` / `htm` / `cnf.jkt` (see
  [`@dwk/dpop`](dpop.md)).
- **Strict `jti` replay** enforced in the DO for writes. Each seen `jti` is
  stored with an expiry (the proof/token `exp`, or a bounded max validity
  window) and **pruned** — periodically and/or opportunistically during write
  transactions — so the replay table cannot grow unbounded.
- Reads MAY use a short edge-cached replay window — a **documented tradeoff**.

### Concurrency

- All writes funnel through the single-threaded per-pod DO.
- `If-Match` / ETag check and the write happen together with **no TOCTOU**.

### Oversized / binary bodies → R2 copy-on-write

- Write a new **content-addressed** R2 key, then **atomically flip** the DO
  pointer.
- `DELETE` drops the pointer first; the object is **GC'd later** via a cron
  Worker, with a safety window **≥ max write duration**.
- RDF over the ~2 MB DO-cell ceiling is treated as an **opaque body**.

### Notifications

- Solid Notifications via **WebSocket channels**, implemented on the DO's
  **hibernatable WebSockets**.

## Bindings (declared `Env` fragment)

- **Durable Object namespace** for the per-pod class (exported by this package).
- **R2 bucket** for blob bodies.
- Secrets / config for the token issuer JWKS endpoint.
- A **cron trigger** for R2 garbage collection.

## Config

- `baseUrl` / WebID identity root.
- Token issuer / JWKS configuration and accepted `aud`.
- DO-cell size threshold that triggers R2 offload.
- Read replay-window duration (the documented tradeoff above).
- GC safety-window duration.

## Conformance

- Solid conformance suites + real Solid clients; interop is the bar. See
  [conformance-and-testing.md](../conformance-and-testing.md).

## Related deferred items

- v1 is **Resource Server only** — no OIDC OP.
- **No sharding** of a single pod across DOs in v1.

See [open-questions.md](../open-questions.md).
