---
"@dwk/cf-shims": minor
"@dwk/server": patch
---

Add `@dwk/cf-shims` (#381): Node-backed implementations of the Cloudflare
Workers binding interfaces — `D1Database` → `node:sqlite`, `R2Bucket` →
filesystem, `KVNamespace` → SQLite/memory, an in-process durable `Queue`, a
cron/`scheduled` timer, and Durable Object emulation (`SqlStorage`, per-id
single-writer mutex, alarms, WebSocket hibernation) — plus the runtime-global
seams a Worker gets for free and Node does not: the `cloudflare:workers`
module stand-in and its `module.register` loader hook, a WASM `HTMLRewriter`
polyfill, a `crypto.DigestStream` polyfill, and `WebSocketPair`/hibernatable-
`WebSocket` globals.

Extracted verbatim from `@dwk/server`'s internal `./shims` (already mechanical
per `spec/self-hosting.md` §16 decision 6), so any Node host — a bare
`node:http` server, a test harness, a future Deno-compat host — can reuse
them without copying source. `@dwk/server` now depends on `@dwk/cf-shims` via
`workspace:*` and is its first consumer, not its owner; `web-socket-upgrade.ts`
(bridging the emulated `WebSocketPair` to a real HTTP `Upgrade` socket over the
`ws` package) stays in `@dwk/server` since it is genuinely host-specific. No
behavior change — `@dwk/server`'s public exports are unchanged (now re-exported
from `@dwk/cf-shims`), and its full `phase*.integration.test.ts` suite
continues to pass unmodified as `@dwk/cf-shims`'s de facto integration test.
