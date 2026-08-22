---
"@dwk/server": minor
---

Phase 4 (part) — Durable Object emulation, and bring up `@dwk/webauthn` on it.

- Add a Node Durable Object emulation behind the `cloudflare:workers` boundary:
  `SqlStorage` over `node:sqlite` (the `sql.exec(...).one()/.toArray()` cursor),
  a `DurableObjectState` (`storage.sql` + `transactionSync` + `id` +
  in-memory `acceptWebSocket`/`getWebSockets`), the `DurableObject` base class,
  and a `DurableObjectNamespace` whose `get(id).fetch(req)` routes in-process to
  a singleton instance per id **serialised behind a per-id promise chain** —
  reproducing the single-writer guarantee. One SQLite file per object id under
  `<dataDir>/do/<className>/`.
- Resolve the `cloudflare:workers` bare specifier (the packages' only runtime
  import from it, `{ DurableObject }`) to the shim: a `module.register` loader
  hook (`registerCloudflareWorkers`, for the `bin`) and a Vitest `resolve.alias`
  (tests), so `@dwk/webauthn` / `@dwk/solid-pod` / `@dwk/activitypub` run
  unchanged from source/dist.
- Add `installRequestDuplex()` (called from `createServer`): defaults Node's
  `Request` `duplex: "half"` for streaming-body requests, so the packages'
  DO sub-request forwarding (`new Request(url, { body: request.body })`) — valid
  on workerd — works on Node.
- Bring up `@dwk/webauthn` end-to-end through the host on the emulated per-RP DO
  (registration/authentication challenge ceremonies), plus unit tests for the DO
  emulation (SqlStorage, per-id serialisation under concurrency, per-id state
  isolation, stable ids).

`@dwk/solid-pod` (LDP/WAC/N3-patch over the same DO machinery, with authz) and
WebSocket-backed Solid notifications are the remaining Phase 4 work.
