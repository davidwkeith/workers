# @dwk/solid-pod

Solid Pod — the flagship endpoint + Durable Object.

## What this is

Edge-native Solid Protocol implementation. Stateless Worker front door routes to
a per-pod Durable Object (`SolidPodObject`) that is the consistency, authz, and
notification authority. The DO uses SQLite for the quad store and R2 for large
blob bodies via `@dwk/store`. Implements full LDP resource/container semantics,
Turtle/JSON-LD content negotiation, N3 Patch with `solid:where` matching, WAC
evaluation, DPoP-bound access tokens, If-Match/ETag TOCTOU-free writes,
oversized RDF → R2 copy-on-write, and WebSocket notifications. Also
contributes `@dwk/mcp` tools (`createSolidPodMcpTools` → `solid_pod_read`/
`solid_pod_write`) that dispatch through the same DO the HTTP door uses, so
WAC is a second, resource-level gate beneath the MCP scope check.

## Spec

`spec/packages/solid-pod.md` — authoritative requirements. This is the most
complex package in the monorepo.

## Key constraints

- **Single-threaded DO is the consistency authority.** All reads and writes go
  through the DO. No caching of ACL decisions or state outside it.
- **TOCTOU-free writes.** If-Match/ETag checks and the actual write happen in
  a single SQLite transaction inside the DO. No window for concurrent mutation.
- **N3 Patch with bounded solver.** `solid:where` patterns use a bounded
  conjunctive solver with configurable bind-count and candidate-cost thresholds
  to prevent DoS via cartesian-product patterns.
- **Stream R2 bodies.** Large blobs stream through the Worker — never buffer a
  full blob in DO memory (128 MB limit).
- **WAC evaluation per request.** Every request evaluates WAC fresh via
  `@dwk/wac`. No ACL result caching.
- **DPoP everywhere.** Every authenticated request must present a valid DPoP
  proof. JTI replay prevention happens in the DO's strongly-consistent store.
- **Content negotiation.** Turtle is the default for RDF resources; JSON-LD is
  served when the client prefers it. The `@dwk/rdf` library handles
  parse/serialize.
- **GC for R2 orphans.** The `createSolidPodGc` handler + D1 `GC_DB` implements
  the orphan-outbox GC pattern from `@dwk/store`.
