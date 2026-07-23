# `@dwk/cf-shims` — Node implementations of the Cloudflare binding interfaces

> **Status: implemented.** Extracted from `@dwk/server`'s shim layer
> ([#381](https://github.com/davidwkeith/workers/issues/381), per
> [self-hosting.md §16](../self-hosting.md) decision 6). This package is the
> **reference implementation of [host-contract.md](../host-contract.md)**; that
> document is normative for every behaviour here, and this spec covers only
> what is specific to the package itself.

## 1. Role

A host-side library: Node-backed implementations of the portable subset of the
Cloudflare binding interfaces, so that any Node-shaped host — `@dwk/server`
(the first consumer), a bare `node:http` server, a test harness, a future Deno
host via `node:` compat — can run the `@dwk` endpoint packages unchanged.
It is **not** a mountable worker (a `catalog.json` `libraries` exclusion) and
is **not** consumed by any endpoint package — the dependency arrow points only
from hosts to this package.

## 2. Public surface

| Export | Implements | Host contract |
| --- | --- | --- |
| `createD1Database(location)` | `D1Database` on `node:sqlite` | §3.5 |
| `createR2Bucket(root)` | `R2Bucket` on the filesystem (streaming bodies, etag'd, HTTP-metadata sidecars) | §3.4 |
| `createKVNamespace(options?)` | `KVNamespace` on SQLite or in-memory | §7 (courtesy — KV is a non-requirement) |
| `QueueBroker` | durable SQLite-backed producer + batch-consumer loop with `ack`/`retry`/`attempts` | §3.6 |
| `CronScheduler` | interval-driven `scheduled` handler runner | §3.7 |
| `createDurableObjectNamespace(...)`, `DurableObject`, `DurableObjectState`, `SqlStorage` | the Durable Object lifecycle: per-id single-writer mutex, per-object SQLite `SqlStorage` + `transactionSync`, durable alarms with bounded-backoff retry, hibernation-style WebSockets | §3.2–3.3 |
| `registerCloudflareWorkers()`, `resolve` | `module.register` loader hook resolving the bare `cloudflare:workers` specifier to the module stand-in (also exported as the `@dwk/cf-shims/cloudflare-workers` subpath, for bundler aliases) | §5 |
| `installHTMLRewriter()` | WASM `lol-html` as the `HTMLRewriter` global | §6 |
| `installCryptoDigestStream()` | `crypto.DigestStream` on `node:crypto` | §6 |
| `installWebSocketGlobals()`, `WebSocketPair`, `EmulatedWebSocket`, `responseWebSocket` | `WebSocketPair` + the 101-`webSocket` `Response` | §6 |

All `install*` functions MUST be idempotent and MUST be no-ops where a native
global already exists (so importing the package under `workerd` is harmless).

## 3. Boundary rules (load-bearing)

- The package MUST import **Node built-ins only** (`node:sqlite`, `node:fs`,
  `node:crypto`, `node:stream`, `node:path`, `node:module`) plus the
  `@worker-tools/html-rewriter` WASM build. No Express, no `ws`, no
  host-runtime imports — network concerns (HTTP upgrade bridging of the
  emulated WebSocket pairs) belong to the consuming host
  (`@dwk/server`'s `web-socket-upgrade`).
- No endpoint package may depend on `@dwk/cf-shims`; endpoint packages program
  against the Cloudflare interfaces and stay host-agnostic
  ([composition-contract.md](../composition-contract.md)).
- **Single writer per data directory.** The per-id mutex reproduces the
  Durable Object single-writer guarantee only within one process. Enforcing
  the one-process invariant (lockfile, deployment discipline) is the consuming
  host's responsibility and MUST be documented by every consumer
  ([self-hosting.md §8](../self-hosting.md)).
- Node ≥ 22 (`node:sqlite`; ≥ 24 for flagless stable use), same floor as
  `@dwk/server`.

## 4. Contract-growth coupling

[host-contract.md §8](../host-contract.md) binds this package from the other
side: when an endpoint package legitimately needs new Cloudflare surface, the
same PR MUST amend the host contract **and** implement the surface here. A gap
between the contract and this package is a release-blocking documentation bug.

## 5. Testing

Colocated unit tests (`src/*.test.ts`, Node environment) are the
**shim-parity suite** of host-contract §9 step 1: alarm durability across
restarts and retry-on-throw, per-id mutex serialization, D1 result envelopes
(`meta.changes`, batch atomicity), R2 streaming and metadata round-trips,
queue redelivery/`attempts`/`delaySeconds`, loader-hook resolution, and the
idempotence of every `install*`. The composed end-to-end coverage (step 2)
lives in `@dwk/server`'s `phase*.integration.test.ts` suites, which exercise
these shims through real package lifecycles.
