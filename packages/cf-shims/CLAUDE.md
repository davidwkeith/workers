# @dwk/cf-shims

Node-backed implementations of the Cloudflare Workers binding interfaces —
extracted from `@dwk/server`'s internal shim layer so any Node host can reuse
them.

## What this is

Each export implements the **same TypeScript interface** the endpoint packages
already program against (the Cloudflare Workers types), so a package composed
over these shims is oblivious to the host: `D1Database` → `node:sqlite`,
`R2Bucket` → filesystem, `KVNamespace` → SQLite/memory, an in-process durable
`Queue`, a cron/`scheduled` timer, and Durable Object emulation (`SqlStorage`,
per-id single-writer mutex, alarms, WebSocket hibernation). Alongside the
binding shims it ships the runtime-global seams a Worker gets for free and Node
does not: the `cloudflare:workers` module stand-in (`{ DurableObject }`) plus
the `module.register` loader hook that redirects the bare specifier to it, a
WASM `HTMLRewriter` polyfill, a `crypto.DigestStream` polyfill, and
`WebSocketPair`/hibernatable-`WebSocket` globals.

`@dwk/server` is this package's first consumer, not its owner — it composes
these shims behind Express, adds the Express⇄Fetch adapter and static hosting,
and bridges real HTTP `Upgrade` sockets to the WebSocket globals here
(`web-socket-upgrade.ts`, which stays in `@dwk/server` since it depends on the
`ws` package and a real `node:http` server).

## Spec

`spec/packages/cf-shims.md` — authoritative requirements. Also
`spec/self-hosting.md` §7 (the shim design this package implements) and
`spec/portability.md` (the extraction rationale, §2.3/§5 Phase 0).

## Key constraints

- **Not protocol-agnostic, by design.** Unlike `@dwk/rdf`/`@dwk/dpop`/etc.,
  this package's entire purpose is emulating Cloudflare's runtime surface —
  Cloudflare specifics are exactly what it is for.
- **Host-framework-free.** Every module imports only Node built-ins
  (`node:sqlite`, `node:fs`, `node:crypto`, `node:stream`, `node:module`) plus
  `@worker-tools/html-rewriter`. Never import Express or any other host
  framework — that is what keeps this package reusable by a host other than
  `@dwk/server`.
- **`node:sqlite` floor.** D1, KV, and the Durable Object shim use the
  built-in, synchronous `node:sqlite`, which sets this package's floor at
  **Node ≥ 22** (≥ 24 for flagless stable use).
- **Interface fidelity over convenience.** Each shim matches the Cloudflare
  type it stands in for exactly (including quirks like D1's
  `{ results, success, meta }` envelope) — a consuming package must run
  unchanged against it.
