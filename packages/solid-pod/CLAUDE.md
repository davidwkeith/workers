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

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- DO: `SolidPodObject` (useSQLite)
- R2: `BLOBS`
- D1: `GC_DB`
- Compatibility flags: `nodejs_compat`
- Resolve alias: `readable-stream` → `node:stream` (for N3.js in workerd)

Has `test-harness.ts` (excluded from build and published files).

```bash
pnpm test --project @dwk/solid-pod
```

## File layout

```
src/index.ts        # public surface: createSolidPod, GC handler, SolidPodObject, types
src/config.ts       # SolidPodConfig type, Env fragment, AuthContext, Jwks
src/handler.ts      # createSolidPod factory (LDP routes) + createSolidPodWebdav /
                    # createSolidPodWebdavCredentials (the WebDAV second door)
src/pod.ts          # SolidPodObject Durable Object (the core, incl. WebSocket notifications)
src/gc.ts           # createSolidPodGc (orphan R2 blob cleanup)
src/ldp.ts          # LDP resource/container semantics
src/patch.ts        # N3 Patch parsing and bounded where-clause solver
src/negotiation.ts  # content negotiation (Turtle/JSON-LD)
src/auth.ts         # DPoP token validation, AuthContext construction
src/jwt.ts          # JWT decode + JWKS signature verification (asymmetric only)
src/encoding.ts     # base64url/UTF-8 helpers for the edge auth path
src/wac.ts          # effective-.acl resolution, decision deferred to @dwk/wac
src/event.ts        # schema.org RDF ↔ @dwk/calendar CalendarEvent adapter (#172)
src/mcp-tools.ts    # createSolidPodMcpTools — solid_pod_read/solid_pod_write @dwk/mcp tools
src/log.ts          # structured logging/metrics event vocabulary
src/test-harness.ts # test-only DO class (not published)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/calendar` — canonical `CalendarEvent` model for the RDF event adapter.
- `@dwk/dpop` — DPoP proof verification.
- `@dwk/ldn` — inbox discovery and LDN primitives.
- `@dwk/log` — structured logging.
- `@dwk/mcp` — `ToolDefinition`/`ToolCallResult` types for `mcp-tools.ts`.
- `@dwk/rdf` — RDF parsing/serialization.
- `@dwk/store` — DO SQLite + R2 storage layer.
- `@dwk/wac` — Web Access Control evaluation.
- `@dwk/webdav` — Class 2 WebDAV router + lock/app-password stores, wired onto
  this DO by `createSolidPodWebdav` (the "second door").
