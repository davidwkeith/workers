---
"@dwk/server": minor
---

Add `@dwk/server` — a Node.js/Express self-hosting host for the `@dwk` packages.

It is the Node analogue of "the Worker entry + `wrangler.toml`" a Cloudflare
deployer writes by hand: it composes the endpoint factories, bridges Express
`(req, res)` ⇄ Web `Request`/`Response` (streaming both ways), serves static
files alongside the endpoints with deterministic routing precedence (reserved
protocol paths win over static files), and constructs the `Env` from Node-backed
shims for the Cloudflare binding interfaces so the endpoint packages run
unchanged — mirroring how `@dwk/store` confines Cloudflare storage.

This first cut covers the host skeleton + adapter + static hosting, the storage
shims (`D1Database` → `node:sqlite`, `R2Bucket` → filesystem, `KVNamespace` →
SQLite/memory), and the lifecycle shims (`waitUntil` tracking, an in-process
SQLite-backed durable Queue with retry/backoff/dead-letter, and a cron/
`scheduled` timer) — enough to self-host the stateless and D1/R2-backed packages.
Correctness is at least as strong as the Cloudflare target (a single Node process
over local SQLite is strictly serializable), guarded by a single-writer
lockfile. Durable Object emulation and the Docker image / CLI follow.

Requires Node ≥ 22 (the SQLite shim uses the built-in `node:sqlite`).
