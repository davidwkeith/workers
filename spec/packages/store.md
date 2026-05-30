# `@dwk/store`

| | |
|---|---|
| **Type** | lib |
| **Ships a DO?** | no (runs *inside* the `solid-pod` DO) |
| **Used by** | [`@dwk/solid-pod`](solid-pod.md) |

Encapsulates the **DO-SQLite quad store** + **R2 copy-on-write blob bodies**
behind a single interface, keeping endpoint packages storage-agnostic and
unit-testable.

## Functional requirements

- Expose **one storage interface** over two backends:
  - the **Durable Object SQLite** quad store (triples), and
  - **R2** for blob bodies.
- **Copy-on-write blob bodies in R2:**
  - write a new **content-addressed** key, then **atomically flip** the DO
    pointer to it;
  - on delete, **drop the pointer first** and enqueue the now-orphaned key to a
    shared tracking store (a D1 table or a queue) in the same transaction; a
    cron Worker drains that list and deletes the R2 objects after a safety
    window **≥ max write duration**. The GC Worker MUST NOT scan/wake every
    per-pod DO — orphaned keys are reported by the DO at delete time, not
    discovered by a full sweep.
- Treat any body over the ~2 MB DO-cell ceiling as an **opaque blob** routed to
  R2 rather than the quad store.
- Support transactional writes so `solid-pod` can apply N3 Patch
  `deletes`+`inserts` in **one SQLite transaction**, and so `If-Match`/ETag
  check-and-write is **TOCTOU-free**.

## Design constraints

- Confines Cloudflare storage specifics here (and in endpoint packages), so the
  pure libs (`@dwk/wac`, `@dwk/rdf`, `@dwk/dpop`) stay runtime-free (see
  [composition-contract.md](../composition-contract.md#confinement-of-cloudflare-specifics)).
- Authoritative state lives **only** in DO SQLite and R2 — never KV (see
  [non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- **Stream R2 bodies** — never buffer a full blob in the DO.

## Testing

- Unit/integration tests under Miniflare/`workerd`: transactional quad
  read/write, copy-on-write pointer flip, delete-then-GC ordering, and the
  size-threshold routing between SQLite and R2.
