# `@dwk/cf-shims`

| | |
|---|---|
| **Type** | lib (Cloudflare-interface emulation, extracted from `@dwk/server`) |
| **Ships a DO?** | no (emulates one) |
| **Used by** | [`@dwk/server`](../self-hosting.md) (first and, today, only consumer) |

Node-backed implementations of the Cloudflare Workers binding interfaces —
`D1Database`, `R2Bucket`, `KVNamespace`, `Queue`, cron/`scheduled`, and Durable
Objects — plus the runtime-global seams a Worker gets for free and Node does
not (`cloudflare:workers`'s `DurableObject` base class and its
`module.register` resolution hook, `HTMLRewriter`, `crypto.DigestStream`, and
hibernatable `WebSocket` globals). Extracted from `@dwk/server`'s internal
`./shims` (issue #381; see [self-hosting.md §16](../self-hosting.md#16-resolved-decisions)
decision 6 and [portability.md §2.3](../portability.md#23-dwkserver-is-the-existence-proof)),
so any Node host — `@dwk/server`, a bare `node:http` server, a test harness, a
future Deno-compat host — can reuse them without copying source.

This is the one package in the taxonomy that is **not** a cross-standard
reusable lib in the `@dwk/rdf`/`@dwk/dpop` sense: its entire purpose is
Cloudflare-interface emulation, so it is exactly as Cloudflare-specific as
`@dwk/store` and the endpoint packages — see
[composition-contract.md](../composition-contract.md#confinement).

## Functional requirements

- **`createD1Database(path)`** — `D1Database` over `node:sqlite`:
  `prepare(sql).bind(...).all()/.first()/.run()`, `batch()`, `exec()`, matching
  D1's `{ results, success, meta }` envelope exactly.
- **`createR2Bucket(dir)`** — `R2Bucket` over the filesystem: `get`/`put`/
  `delete`/`list`/`head`, streaming bodies to/from disk (never buffering a full
  object), with an HTTP-metadata sidecar and a computed ETag.
- **`createKVNamespace(options)`** — `KVNamespace` over SQLite (or an in-memory
  `Map`), with TTL/expiration support. KV here is strongly consistent (no
  "≈60 s eventual" caveat), but callers MUST still treat it as
  safe-to-be-stale-cache-only, matching the non-functional consistency rule.
- **`QueueBroker`** — an in-process, SQLite-backed durable queue: `send`/
  `sendBatch` producers, a worker loop delivering `MessageBatch`-shaped batches
  to a registered consumer with `ack`/`retry`/`ackAll`/`retryAll`, a visibility
  lease, exponential backoff, and a dead-letter cap.
- **`CronScheduler`** — runs a registered `scheduled` handler on a timer,
  passing a `ScheduledController`-shaped argument; cadence is milliseconds, no
  cron-expression parser.
- **`createDurableObjectNamespace` / `DurableObject`** — Durable Object
  emulation: `SqlStorage` over `node:sqlite`, `idFromName`/`get(id).fetch`
  routed in-process to a per-id singleton serialised behind a per-id mutex
  (the single-writer guarantee), `blockConcurrencyWhile`, persisted alarms
  (survive a restart, retried with bounded backoff), and WebSocket
  hibernation (`acceptWebSocket`/`getWebSockets`) dispatching to a subclass's
  `webSocketMessage`/`webSocketClose`/`webSocketError` overrides.
- **`registerCloudflareWorkers()` / `resolve()`** — a `module.register` ESM
  loader hook redirecting the bare `cloudflare:workers` specifier to this
  package's `DurableObject` stand-in, so the endpoint packages' unmodified
  `import { DurableObject } from "cloudflare:workers"` resolves under Node.
- **`installHTMLRewriter()`** — installs a WASM-backed, workerd-compatible
  `HTMLRewriter` global if none exists (idempotent, no-op if already present).
- **`installCryptoDigestStream()`** — installs a `node:crypto`-backed
  `crypto.DigestStream` global (Cloudflare's non-standard streaming-hash
  `WritableStream`) if none exists.
- **`installWebSocketGlobals()` / `WebSocketPair` / `EmulatedWebSocket` /
  `responseWebSocket()`** — an in-memory `WebSocketPair` and a `Response`
  patched to carry a `webSocket` + status `101` (which Node's own `Response`
  rejects), so a Durable Object can answer an upgrade
  (`new Response(null, { status: 101, webSocket })`) the same way it would on
  workerd. Bridging the emulated socket to a *real* network connection (an
  actual HTTP `Upgrade`) is host-specific and stays in `@dwk/server`
  (`web-socket-upgrade.ts`), since it depends on the `ws` package and a real
  `node:http` server — not something every consumer of this package needs.

## Design constraints

- **Host-framework-free.** Every module imports only Node built-ins
  (`node:sqlite`, `node:fs`, `node:crypto`, `node:stream`, `node:module`) plus
  `@worker-tools/html-rewriter`. No Express, no other host framework — that is
  the boundary that keeps this package reusable outside `@dwk/server`.
- **Interface fidelity.** Each shim implements the exact TypeScript interface
  (`@cloudflare/workers-types`) the endpoint packages already program against,
  so a package composed over these shims runs **unchanged**.
- **`node:sqlite` floor.** D1, KV, and the Durable Object shim require Node
  ≥ 22 (≥ 24 for flagless stable use); the driver is confined to each shim
  module so it stays swappable.
- **Single-process, single-writer.** The Durable Object namespace's per-id
  mutex reproduces the single-writer guarantee within one process; a host
  composing multiple processes over the same data directory is out of scope
  here (the host's job — see `@dwk/server`'s startup lockfile).

## Testing

- Unit tests under Node (no Miniflare): each shim against the Cloudflare
  interface shape it stands in for (D1's result envelope, R2's streaming
  get/put/list, KV's TTL expiry, the Durable Object namespace's per-id
  serialisation/alarm persistence/retry, the loader hook's specifier
  redirection, the `HTMLRewriter`/`DigestStream`/`WebSocketPair` polyfills'
  idempotency and shape).
- `@dwk/server`'s own `phase*.integration.test.ts` suite is this package's de
  facto integration test: every endpoint package that ships a Durable Object
  runs its full lifecycle against these shims through the host.
