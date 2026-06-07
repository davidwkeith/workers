# Self-hosting on Node.js / Express (design & feasibility)

> **Status: proposed — design only, not adopted.** This document is a
> feasibility study for running the `@dwk` packages outside Cloudflare, as a
> single long-running Node.js process fronted by Express, with static file
> hosting alongside the standards endpoints. It does **not** change any runtime
> code, and it does **not** by itself overturn the
> [`overview.md` §3 non-goal](overview.md#3-non-goals-v1) that names Cloudflare
> the sole deployment target. Adopting it is a separate decision (see
> [§3](#3-relationship-to-the-cloudflare-only-non-goal)).

## 1. Motivation

The project's thesis is self-ownership: "the data and keys live only on
infrastructure the user owns." Today "infrastructure the user owns" means a
Cloudflare account. That is genuinely serverless and scales to zero, but it is
still **someone else's platform** — it requires a Cloudflare account, the
`wrangler` toolchain, and acceptance of Cloudflare's terms, and it forecloses
the most literal form of self-hosting: a box (a VPS, a homelab server, a
Raspberry Pi, a NAS) running a plain Node process the user fully controls.

A meaningful share of the IndieWeb/Solid audience already self-hosts this way.
Offering an **Express server + static hosting** target would let those users
run the same standards implementations on hardware they own, serve their
website and their endpoints from one process, and avoid a cloud dependency
entirely — without forking the protocol logic.

## 2. The key enabling fact

The composition contract already specifies a **runtime-neutral** handler shape
([composition-contract.md](composition-contract.md#handler-shape)):

```ts
createX(config): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
```

`Request`, `Response`, `fetch`, `ReadableStream`, `Blob`, `crypto.subtle`, and
`crypto.randomUUID` are all part of the **WHATWG/Web platform** and are
implemented natively by **Node.js ≥ 20** (the repo's stated minimum). The
endpoint handlers are written against those globals, not against Node or
Cloudflare HTTP APIs. This means:

- **The protocol logic is already portable.** A handler that parses a
  `Request`, talks to its `Env` bindings, and returns a `Response` does not care
  whether the event loop is `workerd` or Node, provided the bindings it is
  handed behave like the Cloudflare interfaces.
- **The portability gap is entirely in the `Env` bindings and the lifecycle
  hooks** (`ExecutionContext.waitUntil`, the `scheduled`/`queue` Worker entry
  points, and the `cloudflare:workers` `DurableObject` base class). These are
  the only Cloudflare-specific surfaces the handlers touch.

So the work is **not** a rewrite of the packages. It is (a) a thin HTTP adapter
that bridges Express's `(req, res)` to the fetch handler, and (b) a set of
**Node-native shims that implement the Cloudflare binding interfaces** on top of
SQLite and the local filesystem.

## 3. Relationship to the Cloudflare-only non-goal

[`overview.md` §3](overview.md#3-non-goals-v1) currently states:

> **Runtimes other than Cloudflare Workers.** Cloudflare is the sole deployment
> target; packages MAY freely assume Workers, Durable Objects, R2, D1, and KV
> primitives.

This design **does not require weakening that licence to assume Cloudflare
primitives**, and that is deliberate. The portability strategy is *not* "make
the packages runtime-agnostic." It is "**re-implement the Cloudflare primitive
interfaces on Node**, and let the packages keep assuming them." The packages
keep importing `cloudflare:workers`, keep typing their bindings as `D1Database`
/ `R2Bucket` / `DurableObjectNamespace`, and keep streaming R2 bodies — the host
makes those names resolve to Node-backed implementations.

That keeps the existing confinement principle intact and inverts it cleanly:

- `@dwk/store` confines *Cloudflare storage* so the pure libs stay runtime-free.
- A new **`@dwk/server`** package confines *the Node runtime and the
  Cloudflare-interface emulation* so the endpoint packages stay unchanged.

If this path is adopted, the **only** spec edit required is to reclassify the
non-goal: change "Cloudflare is the sole deployment target" to "Cloudflare is
the primary target; a Node/Express host is a supported secondary target that
emulates the Cloudflare primitive interfaces," and add this file's normative
parts to the spec set. Until that decision is made, this document stands as a
proposal and the non-goal stands as written.

## 4. Goals / non-goals of the self-host path

### Goals

- Run **all** endpoint packages — the IndieWeb trio, `microsub`, `websub`,
  `webfinger`, `host-meta`, `vc`, **and** `solid-pod` / `webauthn` (the Durable
  Object packages) — in **one Node process** behind **one Express app** on one
  domain.
- **Zero external services** for the default install: persistence is **SQLite +
  the local filesystem**. No Postgres, no S3, no Redis required to start.
- Serve **static files** (the user's website) from the same process and domain
  as the endpoints, with deterministic routing precedence between them.
- **Reuse the protocol logic byte-for-byte** — no second implementation of any
  standard, so conformance results transfer.
- Preserve the [composition contract](composition-contract.md): config is
  injected, bindings are declared, missing bindings fail loudly at startup.

### Non-goals

- **Horizontal scale / clustering.** The Durable Object model assumes a single
  authoritative writer per object id. The Node host satisfies that with an
  in-process lock, which is correct **only in a single process**. Running
  multiple Node processes (PM2 cluster, k8s replicas) behind a load balancer is
  explicitly out of scope for the default design (see
  [§7.4](#74-durable-objects-the-hard-part) and [§8](#8-consistency--correctness)).
- **Matching Cloudflare's edge features.** TLS termination, DDoS protection,
  global anycast, and built-in rate limiting are platform features the user now
  owns themselves (reverse proxy / firewall). See [§12](#12-security).
- **A managed/hosted product.** Same non-goal as the Cloudflare path: this is
  software the user runs, not a service we operate.

## 5. Architecture

```
            ┌─────────────────────────────────────────────────────────┐
  client ──▶│  Express app  (@dwk/server)                              │
            │   ├─ static middleware  (express.static, the website)    │
            │   ├─ well-known + endpoint routes → fetch adapter        │
            │   └─ 404                                                  │
            └──────────────┬──────────────────────────────────────────┘
                           │  Web Request  ──▶  composed fetch handler
                           ▼
            ┌─────────────────────────────────────────────────────────┐
            │  composed handler (unchanged @dwk endpoint packages)     │
            │   sees an `Env` of Node-backed binding shims:            │
            └───┬──────────┬──────────┬───────────┬───────────┬────────┘
                │          │          │           │           │
            D1→SQLite  R2→files   KV→SQLite   DO→sql+lock   Queue→in-proc
                                                   │
                                          per-id SQLite DB + async mutex
                                          + WebSocket-hibernation shim
```

The new package is **`@dwk/server`** (working name; `@dwk/node-host` is an
alternative). It is the Node analogue of "the Worker entry + `wrangler.toml`"
that a Cloudflare deployer writes by hand, packaged and reusable. Its
responsibilities:

1. **Compose** the endpoint packages' factories (the same `createIndieAuth`,
   `createMicropub`, … calls a Worker entry makes), routed by path prefix.
2. **Adapt** Express `(req, res)` ⇄ Web `Request`/`Response`
   ([§6](#6-the-http-adapter-and-static-hosting)).
3. **Construct the `Env`** from Node-backed shims for every Cloudflare binding
   the mounted packages declare ([§7](#7-binding-shims-runtime-parity)).
4. **Drive the lifecycle** the Cloudflare runtime would otherwise drive: run the
   queue consumers, fire the cron/`scheduled` handlers on a timer, and track
   `waitUntil` work ([§7.5](#75-queues-cron-and-waituntil)).
5. **Serve static files** and own routing precedence
   ([§6.3](#63-static-hosting-and-routing-precedence)).

Crucially, `@dwk/server` is the **only** new place Node-specific code lives. The
20+ existing packages are imported and used exactly as a Worker would use them.

## 6. The HTTP adapter and static hosting

### 6.1 Express → Web Request

For each incoming Express request the adapter builds a Web `Request`:

- **URL:** reconstruct the absolute URL from the configured public origin
  (`baseUrl`) + `req.originalUrl`. The origin comes from config, **not** from
  the `Host` header, because the handlers derive identity (issuer, WebID, post
  URLs) from `baseUrl` and a spoofable `Host` must never feed that.
- **Method / headers:** copied straight across.
- **Body:** Express request streams are Node `Readable`s; wrap as a
  `ReadableStream` (`Readable.toWeb`) so large uploads (Micropub media, R2
  blobs) are **streamed, never buffered** — the same non-functional requirement
  the Worker path honours. The adapter MUST **not** install a body parser
  (`express.json()` etc.) ahead of the endpoint routes, or the stream is
  consumed before the handler sees it.

### 6.2 Web Response → Express

Copy status and headers; pipe `response.body` (a `ReadableStream`) to the
Express `res` with `Readable.fromWeb(...).pipe(res)`. Streaming preserves the
"don't buffer a full blob" rule on the way out (R2 GET, media serving).

> The Express↔fetch bridge is a small, well-understood shim; mature
> implementations exist (`@whatwg-node/server`, Hono's Node adapter). `@dwk`
> can depend on one or vendor a ~100-line version to keep the dependency
> surface minimal and pinned, per the distribution rules.

### 6.3 Static hosting and routing precedence

Self-hosters want their **website and their endpoints on one origin**. The
Express app mounts, in this order:

1. **Reserved protocol paths first** — `/.well-known/*` (webfinger, host-meta,
   oauth metadata, DID), the configured IndieAuth / Micropub / Webmention /
   Microsub / WebSub / Pod / media paths. These are dispatched to the fetch
   adapter and MUST win over any static file of the same name.
2. **`express.static(publicDir)`** — the user's generated site (e.g. an
   Anglesite/Eleventy build output). Serves `index.html`, assets, etc.
3. **Fallback** — configurable: a 404, or SPA-style `index.html` rewrite.

Precedence is explicit because a static `/.well-known/webfinger` file would
otherwise shadow the WebFinger endpoint. The reserved-paths set is derived from
the same config the handlers are built with, so it cannot drift from where the
handlers actually listen.

This also resolves a subtlety in the Cloudflare model: there, static hosting is
a separate concern (Workers Static Assets / Pages). On Node it folds into the
same process, which is simpler for the self-hoster but makes the precedence rule
above load-bearing.

## 7. Binding shims (runtime parity)

Each shim implements the **same TypeScript interface** the packages already
program against (the Cloudflare Workers types), so the packages are oblivious.
SQLite is provided by **`node:sqlite`** (stable in Node ≥ 22) or
**`better-sqlite3`** (synchronous, battle-tested, works on Node 20); the choice
is an implementation detail behind the shim. Default storage root is a single
configurable data directory (e.g. `~/.dwk/` or `./data/`).

### 7.1 `D1Database` → SQLite

Used by: `indieauth`, `micropub`, `webmention`, `microsub`, `websub`, `vc`,
and the shared GC table (`store`, `solid-pod`, `remotestorage`).

D1's surface is small and SQLite-shaped already: `prepare(sql).bind(...).all()
/ .first() / .run()`, plus `batch()` and `exec()`. The shim wraps a SQLite
connection to provide exactly that object shape (including the
`{ results, success, meta }` envelope D1 returns). **Session/read-your-writes
consistency is automatic** — one local SQLite file is strictly serializable,
which is *stronger* than D1's default and trivially satisfies the
[consistency rules](non-functional-requirements.md#consistency-rules-load-bearing).
One SQLite file (or one file per logical database binding) backs all D1 bindings.

### 7.2 `R2Bucket` → filesystem

Used by: `micropub` (media), `@dwk/store` (blob bodies),
`solid-pod`/`remotestorage` GC.

R2's used surface: `get`, `put`, `delete`, `list`, `head`, plus the returned
object's `body` (a `ReadableStream`), `httpEtag`, `writeHttpMetadata`, and
`size`. The shim stores each object as a file under the data directory, keyed by
the R2 key (content-addressed `sha256-…` keys from `@dwk/store` become file
names), with a sidecar for HTTP metadata (content-type, custom metadata) and a
computed ETag. **Bodies stream to and from disk** — `put` consumes the
`ReadableStream` to a file without buffering; `get` returns a file read stream
as a `ReadableStream` — preserving the no-buffering rule. `list` walks the
directory with prefix/delimiter semantics.

### 7.3 `KVNamespace` → SQLite (or memory)

KV is, by the
[non-functional rules](non-functional-requirements.md#consistency-rules-load-bearing),
**only** ever used for safe-to-be-stale caches — never authz or correctness.
The shim is a trivial key→value table (with TTL/expiration columns) in SQLite,
or an in-memory `Map` if persistence across restarts is not wanted. Because the
Node host is strongly consistent everywhere, the "≈60 s eventual" caveat simply
does not apply; nothing is weakened.

### 7.4 Durable Objects (the hard part)

Used by: `solid-pod` (the per-pod Pod object) and `webauthn` (per-RP object).
This is the only emulation with real subtlety, because Durable Objects provide
**three** guarantees the packages lean on:

1. **Single-threaded execution per object id.** `solid-pod`'s entire
   consistency/authz/notification model rests on "Cloudflare guarantees a single
   thread per pod." The front door routes via
   `env.POD.idFromName(baseUrl)` → `env.POD.get(id).fetch(request)`.
2. **DO-SQLite (`state.storage.sql`).** `@dwk/store`'s `createStore` reads
   `state.storage.sql` (the `SqlStorage` interface) for the quad store; the Pod
   reads it directly too.
3. **Hibernatable WebSockets** (`state.acceptWebSocket()`,
   `state.getWebSockets()`) for Solid notifications.

The Node shim provides a `DurableObjectNamespace` whose `idFromName` mints a
stable id from the name and whose `get(id).fetch(req)` **routes in-process** to a
singleton instance of the DO class per id, serialised behind a **per-id async
mutex** (a promise chain / `async-mutex`). In a single Node process this
reproduces the single-writer guarantee faithfully — arguably more simply than
the distributed original, because there is exactly one process.

- **`SqlStorage`** is backed by a **per-object SQLite database** (one file per
  pod id), exposing the `sql.exec(query, ...bindings)` cursor interface
  `@dwk/store` expects.
- **`DurableObject` base class / `cloudflare:workers` import.** `pod.ts` does
  `import { DurableObject } from "cloudflare:workers"`. Under Node that specifier
  must resolve to a shim. Resolution options, cleanest first:
  - a Node **subpath import / conditions** map or bundler alias that points
    `cloudflare:workers` at `@dwk/server`'s shim for the Node build;
  - a small **loader/`register`** hook;
  - bundling the host with esbuild and aliasing the specifier.
  The shim's `DurableObject` simply stores `ctx` (the emulated
  `DurableObjectState`) and `env`, matching the real base class.
- **WebSocket hibernation.** `acceptWebSocket`/`getWebSockets` map onto a real
  `ws` server the Express server upgrades; "hibernation" is a no-op on Node
  (the object is always resident), which is behaviourally a superset.

**The single-process constraint is the price.** It is acceptable for the
self-host audience (one person, one box) and is exactly the model the DO design
already assumes per pod. It MUST be documented loudly, and the host SHOULD
refuse to start a second writer against the same data directory (a lockfile /
advisory lock on the directory).

### 7.5 Queues, cron, and `waitUntil`

- **`ExecutionContext.waitUntil`.** On Workers this keeps the isolate alive for
  background work after the response. On Node the process is long-lived, so the
  shim just tracks the promise (for graceful-shutdown draining) and otherwise
  lets it run. `ctx.props`/`passThroughOnException` are no-ops.
- **Queues** (`webmention` async verification, `microsub`/`websub` fan-out). The
  packages export both producers (the `Queue` binding) and consumers
  (`createWebmentionQueueConsumer`, `createMicrosubQueueConsumer`, …). The shim
  provides an **in-process queue**: `send`/`sendBatch` enqueue, a worker loop
  delivers batches to the registered consumer with the same `MessageBatch`
  shape, including `retry()` semantics (re-enqueue with backoff) and a
  dead-letter cap. Durability across restarts is optional — back the queue with
  a SQLite table if at-least-once across crashes is wanted; otherwise in-memory
  is acceptable for these "verify later" workloads.
- **Cron / `scheduled`** (`microsub` poller, `solid-pod` & `remotestorage` R2
  GC). The shim runs the `scheduled` handler on a timer (`setInterval` /
  `node-cron`) at the cadence the `wrangler.toml` cron would specify, passing a
  `ScheduledController` shape. The GC cron — which on Cloudflare reclaims
  orphaned R2 blobs and "never sweeps Durable Objects" — runs identically
  against the filesystem-R2 shim.

## 8. Consistency & correctness

The [consistency rules](non-functional-requirements.md#consistency-rules-load-bearing)
demand authoritative state live only in strongly-consistent stores and forbid
KV for authz. **A single Node process over local SQLite is strictly serializable
— strictly stronger than the Cloudflare stack it replaces.** Read-your-writes is
free; the "KV is ≈60 s stale" hazard cannot arise. So the *correctness* posture
of the self-host target is **at least as strong** as the Cloudflare target,
**provided the single-process invariant holds**.

The single invariant the host MUST protect: **exactly one process writes a given
data directory.** Two Node processes sharing a SQLite file and a DO mutex would
each believe they are the single writer for a pod and corrupt the
consistency/authz model. Mitigations: a directory lockfile acquired at startup;
documentation that clustering is unsupported; (future) an opt-in advisory-lock
or leader-election driver for those who insist on HA.

The runtime-budget rules (128 MB, 10 MB script, stream don't buffer) are
**Cloudflare platform limits**, not correctness requirements; on a user's own
box they do not bind. The host keeps the *streaming* discipline anyway (it is
good practice and keeps the code path identical), but drops the script-size and
memory ceilings.

## 9. Configuration & secrets

The composition contract forbids reading the global environment inside packages;
all config is injected. `@dwk/server` is the composition root, so it **is**
allowed to read the environment and assemble config — exactly as a hand-written
Worker entry does. Proposed model:

- A single typed **host config** (a `dwk.config.{ts,json}` or env vars) sets
  `baseUrl`, the data directory, the static `publicDir`, which packages to
  mount and at which paths, and per-package config (issuer, allowed origins,
  size thresholds, syndication targets…).
- **Secrets** (e.g. `TOKEN_SIGNING_KEY`) come from the environment / a secrets
  file and are injected as the corresponding `Env` members, mirroring Worker
  secret bindings. The host MUST **fail loudly at startup** when a mounted
  package's required binding or secret is absent — the same fail-loud rule the
  packages already enforce, surfaced as a clear startup error rather than a
  first-request 500.

## 10. Distribution & CLI

- `@dwk/server` ships **ESM, fully typed**, deps minimised and pinned, like
  every other package. SQLite (`node:sqlite` or `better-sqlite3`) and the
  WebSocket lib (`ws`) are its notable runtime deps; Express is a peer/runtime
  dep.
- A **`bin`** (`dwk-serve` / `npx @dwk/server`) reads the host config and starts
  listening, so a self-hoster's path is: `npm i @dwk/server`, write a config,
  point a reverse proxy at it. A reference `systemd` unit and a `Dockerfile`
  belong in its README.
- It carries its **own changeset and independent semver**, and is marked
  experimental until the conformance suites pass against it
  ([§11](#11-testing--conformance)).

## 11. Testing & conformance

The headline benefit: **the protocol logic is shared, so conformance transfers.**

- The hosted suites (micropub.rocks, webmention.rocks, Solid) are driven by
  `scripts/conformance/run-suite.mjs` against a `--target` URL. Point them at a
  running `@dwk/server` instance to get a **second conformance column** for the
  Node target in `conformance/status.json` (the schema would gain a per-target
  dimension, or a parallel status file).
- The binding shims need their **own unit tests** proving interface parity with
  the Cloudflare types — ideally by running a subset of the existing
  `@cloudflare/vitest-pool-workers` tests against the shims to assert identical
  behaviour (same ETag semantics, same `If-Match` TOCTOU guarantees, same D1
  result envelopes).
- An **integration lifecycle test** equivalent to `pnpm test:integration` but
  against the Node host (boot the Express app, exercise create→read→update→
  delete across packages, assert the DO mutex serialises concurrent writes).

## 12. Security

Cloudflare provided several things for free that the self-hoster now owns:

- **TLS termination** — expected via a reverse proxy (Caddy/nginx/Traefik) or
  Node TLS. Identity (`baseUrl`, issuer, WebID) is HTTPS-rooted, so the docs
  MUST steer users to TLS; the app should refuse a non-localhost `http://`
  `baseUrl` outside an explicit dev mode.
- **DDoS / rate limiting** — now the user's reverse proxy / firewall concern;
  call it out in the README.
- **SSRF surface unchanged** — `webmention`/`microsub` fetch remote URLs; the
  existing `safe-fetch` guards travel with the code, but on a home network the
  blast radius of an SSRF bypass includes the LAN, so the safe-fetch allow/deny
  posture deserves a self-host note.
- **DPoP, least-privilege, no-decision-caching** — all enforced in the shared
  code, unaffected by the runtime.
- **Filesystem permissions** — the data directory holds keys and all pod data;
  the host MUST create it `0700` and document backup/permission expectations.

## 13. Per-package readiness

| Package | Bindings used | Shim difficulty | Notes |
|---|---|---|---|
| `indieauth` | D1, secret | low | SQLite + injected secret. |
| `micropub` | D1, R2 (media) | low | D1 + filesystem R2. |
| `webmention` | D1, Queue | low–med | in-proc queue consumer + safe-fetch. |
| `microsub` | D1, Queue, cron | med | queue + scheduled poller on a timer. |
| `websub` | D1, Queue | low–med | queue consumer + HMAC distribution. |
| `webfinger` | none (config) | trivial | stateless. |
| `host-meta` | none (config) | trivial | stateless. |
| `vc` | D1 | low | status-list in SQLite; DID doc static. |
| `solid-pod` | **DO**, R2, D1(GC) | **high** | SqlStorage + per-id mutex + WS hibernation + GC cron. |
| `webauthn` | **DO** | **high** | per-RP DO; challenge state + credential records. |
| `remotestorage` | R2, D1(GC) | low–med | filesystem R2 + GC cron. |
| `activitypub` | (http-sig, D1/R2) | med | server-to-server delivery via queue/`waitUntil`. |

The IndieWeb trio + the stateless discovery packages are a **low-risk MVP**; the
two Durable Object packages are the deep end and should land behind the DO shim
in [§7.4](#74-durable-objects-the-hard-part).

## 14. Data portability

Because the shims mirror the Cloudflare interfaces, **migrating data between the
two targets is mechanical**, not a transform: D1 ↔ SQLite is the same SQL; R2 ↔
filesystem is key→object; DO-SQLite ↔ per-pod SQLite file is a copy. A future
`dwk migrate` could move a user between their Cloudflare account and their own
box in either direction without touching the protocol layer — a strong
reinforcement of the self-ownership thesis.

## 15. Phased implementation plan

1. **Host skeleton + adapter.** `@dwk/server`: Express app, Express↔fetch
   adapter (streaming both ways), static hosting + routing precedence, host
   config + fail-loud binding assertions, graceful shutdown.
2. **Stateless + D1/R2 shims → IndieWeb trio.** SQLite `D1Database`,
   filesystem `R2Bucket`, KV shim. Mount `indieauth` + `micropub` +
   `webmention` (in-proc queue) + `webfinger`/`host-meta`/`vc` end-to-end; run
   micropub.rocks / webmention.rocks against it.
3. **Lifecycle shims.** `waitUntil`, the in-process queue runner with
   `retry()`/DLQ, and the cron/`scheduled` timer. Bring up `microsub` and
   `websub` and the R2 GC cron.
4. **Durable Object emulation.** `cloudflare:workers` specifier resolution, the
   `DurableObject` base + `DurableObjectState` + `SqlStorage` shims, per-id
   async mutex, namespace `idFromName`/`get`/`fetch` routing, WebSocket
   hibernation. Bring up `solid-pod` (then `webauthn`); run the Solid
   conformance + integration lifecycle.
5. **Packaging.** `bin`/CLI, single-writer lockfile, `systemd` unit + Docker
   reference, README, changeset, and a Node column in `conformance/status.json`.

## 16. Open questions

1. **Specifier resolution for `cloudflare:workers`.** Node subpath
   imports/conditions vs. a loader hook vs. shipping a pre-bundled host. Affects
   whether self-hosters consume source ESM or a bundle.
2. **`node:sqlite` vs `better-sqlite3`.** The former drops a dependency but
   needs Node ≥ 22; the latter works on Node 20 (the current floor) but is a
   native addon. Pick one or abstract behind the shim.
3. **Queue durability default.** In-memory (simplest) vs SQLite-backed
   (survives restart) for webmention/microsub/websub jobs — what is the right
   default for a home server that reboots?
4. **Multi-process story.** Is single-process-forever acceptable, or do we need
   an opt-in advisory-lock/leader driver for HA self-hosters? ([§8](#8-consistency--correctness))
5. **Static hosting scope.** Just `express.static`, or also a templating/render
   hook so the same process can render dynamic IndieWeb pages?
6. **Package name & placement.** `@dwk/server` vs `@dwk/node-host`; and does the
   binding-shim layer warrant its own package (`@dwk/cf-shims`) reusable outside
   the Express host (e.g. for Bun/Deno or test harnesses)?

## 17. Reference links

- [Composition contract](composition-contract.md) ·
  [Non-functional requirements](non-functional-requirements.md) ·
  [Architecture](architecture.md) · [Overview](overview.md)
- **Node Web APIs:** [`fetch`/`Request`/`Response`](https://nodejs.org/api/globals.html) ·
  [`node:sqlite`](https://nodejs.org/api/sqlite.html) ·
  [`stream.Readable.toWeb`/`fromWeb`](https://nodejs.org/api/stream.html)
- **Fetch↔Node adapters:** [`@whatwg-node/server`](https://github.com/ardatan/whatwg-node) ·
  [Hono Node adapter](https://hono.dev/docs/getting-started/nodejs)
- **Cloudflare interfaces being emulated:**
  [D1 client API](https://developers.cloudflare.com/d1/worker-api/) ·
  [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) ·
  [Durable Objects](https://developers.cloudflare.com/durable-objects/) ·
  [DO SQL storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) ·
  [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- **Reference Solid server (long-running Node):**
  [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer)
</content>
</invoke>
