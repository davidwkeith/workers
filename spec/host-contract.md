# Host contract (normative)

> **Status: normative.** This document defines the **portable contract** between
> the `@dwk` packages and the runtime that hosts them: the subset of the
> Cloudflare binding interfaces, semantics, modules, and globals that a
> conforming host MUST provide, and — equally binding — the surfaces the
> packages MUST NOT grow to depend on. It formalizes the inventory in
> [portability.md §2](portability.md) (issue
> [#382](https://github.com/davidwkeith/workers/issues/382)) and is the spec the
> `@dwk/cf-shims` extraction implements. Requirement strength follows
> [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Purpose and scope

The portability strategy ([self-hosting.md §3](self-hosting.md), reaffirmed by
[portability.md §3](portability.md)) is: **the Cloudflare binding interfaces are
the portable contract; hosts re-implement them.** The packages keep importing
`cloudflare:workers`, keep typing their bindings as `D1Database` / `R2Bucket` /
`DurableObjectNamespace`, and a host makes those names resolve to conforming
implementations.

That contract is only usable if it is written down. `@cloudflare/workers-types`
is far larger than what the packages use; this document pins the **actual
subset** — interface members, semantics, modules, and globals — observed in the
production sources (test files and `test-harness.ts` files are excluded; they
may use more because they run under Miniflare).

The contract binds **two audiences**:

- **Host implementers.** A conforming host MUST provide everything in §§3–7 for
  the tier it claims (§9). The reference implementations are Cloudflare's
  `workerd` (definitional) and the Node shims in `@dwk/server`
  (`packages/server/src/shims/`, the future `@dwk/cf-shims`).
- **Package authors.** Production package code MUST NOT use a Cloudflare
  surface outside this contract. A PR that adds a new dependency on a binding
  member, module, or global MUST amend this spec **and** extend the reference
  Node host in the same change — otherwise the contract silently grows and
  every alternative host breaks (§8).

## 2. Web platform baseline

Everything below sits on top of the WHATWG/Web platform surface the
[composition contract](composition-contract.md) already mandates. A host MUST
provide, with standard semantics:

- The fetch-shaped entry points: handlers are
  `(request: Request, env, ctx) => Promise<Response>`; queue consumers are
  `(batch, env, ctx) => Promise<void>`; cron handlers are
  `(controller, env, ctx) => Promise<void>`.
- `Request` / `Response` / `Headers` / `URL` / `URLSearchParams` / `FormData` /
  `Blob` / `File`, `fetch`, `AbortController`/`AbortSignal`,
  `ReadableStream` / `WritableStream` / `TransformStream`,
  `TextEncoder` / `TextDecoder`, `atob` / `btoa`, `structuredClone`,
  `crypto.subtle` (WebCrypto), `crypto.randomUUID`, `crypto.getRandomValues`,
  and timers.
- **Streaming end to end.** Request and response bodies MUST be delivered as
  streams, not buffered: the packages stream large uploads (Micropub media, R2
  blob bodies) and stream R2 bodies back out
  ([non-functional-requirements.md](non-functional-requirements.md)). A host
  adapter that buffers whole bodies does not conform.
- **Outbound `fetch`** for server-to-server traffic (Webmention verification,
  WebSub delivery, ActivityPub delivery, feed polling…). SSRF protection is the
  packages' own job (`@dwk/safe-fetch`); the host MUST NOT silently rewrite or
  proxy outbound requests in ways that defeat it.

Node ≥ 22 provides this baseline natively; `workerd` provides it by
definition.

## 3. Binding interfaces — the portable subsets

The composed `Env` is the union of the mounted packages' declared fragments
([composition-contract.md](composition-contract.md)). For each binding type a
host MUST implement the members below with the stated semantics. Members of the
Cloudflare interfaces **not** listed here are non-requirements (§7) — a host
MAY omit them, though implementing the full upstream interface is always
conforming.

### 3.1 Plain-value bindings (secrets and config)

Secret/environment bindings (e.g. a token-signing key) are plain `string`
members of `Env`. The host MUST inject them at composition time and MUST
support the fail-loud startup check the packages perform — i.e. a missing
binding is detectable as `undefined`, not lazily materialized.

### 3.2 `SqlStorage` (Durable Object SQLite)

Used by: `SolidPodObject`, `ActivityPubObject`, `AtprotoRepoObject`,
`RemoteStorageObject` (via `@dwk/store`), `WebAuthnObject`, and `@dwk/webdav`'s
`LockStore`/`CredentialStore` (which receive an injected `SqlStorage`).

| Member | Required semantics |
| --- | --- |
| `sql.exec<T>(query, ...bindings)` | Execute one SQL statement with positional `?` bindings, **synchronously**, returning a cursor. |
| cursor `.one()` | Exactly-one-row accessor; throws when the result is not exactly one row. |
| cursor `.toArray()` | All rows as an array of plain objects keyed by column name. |
| cursor iteration (`.next()` / `for…of`) | Standard JS iterator over row objects. |
| `storage.transactionSync(fn)` | Run `fn` **synchronously** inside a transaction; commit on return, **roll back entirely when `fn` throws** (the multi-statement writes in `@dwk/store`, `solid-pod`, and `atproto-pds` rely on this atomicity). |

The dialect is **SQLite**. Packages issue raw SQLite SQL, including
`PRAGMA table_info(...)` for idempotent migrations, `INSERT OR IGNORE`, and
`ON CONFLICT` clauses; a conforming implementation is a real SQLite engine (or
something indistinguishable from one), not a translation layer.

### 3.3 Durable Objects

The five stateful classes are `SolidPodObject` (`packages/solid-pod/src/pod.ts`),
`ActivityPubObject` (`packages/activitypub/src/object.ts`), `AtprotoRepoObject`
(`packages/atproto-pds/src/object.ts`), `RemoteStorageObject`
(`packages/remotestorage/src/storage.ts`), and `WebAuthnObject`
(`packages/webauthn/src/rp.ts`).

**Namespace and stub** (used by the stateless front doors):

| Member | Required semantics |
| --- | --- |
| `namespace.idFromName(name)` | Deterministic: the same name MUST always map to the same id. |
| `namespace.get(id)` | Returns a stub for the instance with that id. |
| `stub.fetch(request)` | Delivers the request to the instance's `fetch`, streaming the body, and returns its `Response` — **including a `101` response carrying a `webSocket`**, which the host MUST propagate across the stub and out to the client to complete the upgrade. |

**Instance lifecycle** (what the classes implement and the host must drive):

- Classes extend the `DurableObject` base from `cloudflare:workers` (§5). The
  host constructs an instance with `(ctx, env)` where `ctx` is the
  `DurableObjectState` and `env` the composed bindings.
- `DurableObjectState` members used: `ctx.storage.sql` and
  `ctx.storage.transactionSync` (§3.2), `ctx.storage.setAlarm(time)`,
  `ctx.acceptWebSocket(ws)`, `ctx.getWebSockets()`.
- Event callbacks the host MUST deliver to the instance: `fetch(request)`,
  `alarm()`, `webSocketMessage(ws, message)`, `webSocketClose(ws, code,
  reason, wasClean)`.

**Semantic guarantees** (the load-bearing part — see also
[non-functional-requirements.md](non-functional-requirements.md)):

1. **Per-id single writer.** For a given id there MUST be **at most one live
   instance anywhere**, and all event deliveries to it (`fetch`, `alarm`,
   WebSocket callbacks) MUST execute single-threaded against the same storage.
   The entire consistency/authz model of `solid-pod` rests on this. A host MAY
   serialize whole event deliveries per id (the Node host's per-id mutex does;
   it is strictly stronger than Cloudflare's input-gate model) and packages
   MUST tolerate that stronger serialization.
2. **Durable, single-slot alarms with retry.** `setAlarm(time)` persists the
   (single — a later call replaces it) scheduled time durably: an alarm MUST
   survive host restarts and MUST fire even if no request ever arrives,
   constructing the instance on demand. The pending alarm is cleared **before**
   `alarm()` runs (re-arming is the handler's job). If `alarm()` throws, the
   host MUST retry it with bounded backoff (Cloudflare-style: a handful of
   retries, exponential from seconds), unless the failing run set a new alarm,
   which supersedes the retry. `activitypub` delivery retries and
   `atproto-pds` PLC-genesis retries are built on exactly this.
3. **Hibernatable-style WebSockets.** `ctx.acceptWebSocket(server)` attaches a
   server-side socket to the instance; `ctx.getWebSockets()` returns the
   currently attached sockets (the packages call `.send(...)` and `.close(...)`
   on them); incoming frames and closes arrive via the `webSocketMessage` /
   `webSocketClose` callbacks, serialized per rule 1. Actual hibernation
   (evicting the instance while sockets stay open) is an optimization, not a
   requirement — an always-resident instance is a behavioural superset and
   conforms.
4. **No cross-instance sharing.** Storage is private per id; nothing in the
   contract allows one instance to observe another's `SqlStorage`.

### 3.4 `R2Bucket` (object storage)

Used by: `@dwk/store` (blob bodies; consumed by `solid-pod`, `remotestorage`,
`webdav`), `@dwk/micropub` (media), `@dwk/websub` (fan-out staging),
`@dwk/atproto-pds` (blobs), and the shared GC sweep (`@dwk/store` `gc.ts`).

| Member | Required semantics |
| --- | --- |
| `put(key, value, options?)` | `value` is a `ReadableStream` (MUST be consumed **without buffering the whole body**) or a `BufferSource`. `options.httpMetadata` (at least `contentType`) and `options.customMetadata` MUST round-trip to later reads. |
| `get(key)` | `null` when absent; otherwise an object exposing `body` (a `ReadableStream` — again, streamed, not buffered), `arrayBuffer()`, `size`, `httpMetadata`, `customMetadata`, `httpEtag`, and `writeHttpMetadata(headers)` (writes the stored HTTP metadata into a `Headers`). |
| `head(key)` | `null` when absent; otherwise the metadata-only object: `size`, `uploaded` (a `Date`), `httpMetadata`, `customMetadata`, `httpEtag`. No body. |
| `delete(key)` | Delete a single key; idempotent (deleting an absent key is not an error). |

**Consistency:** reads MUST be read-after-write — a `get`/`head` issued after a
completed `put`/`delete` MUST observe it (Cloudflare R2 guarantees this; a
filesystem does trivially). Eventually-consistent object stores do **not**
conform (this is the same rule that disqualifies eventually-consistent KV for
authoritative state).

**Not required:** `list`, multipart uploads, conditional operations (`onlyIf`),
range reads, checksums options. The GC design deliberately tracks orphans in a
D1 table rather than listing the bucket, so `list` stays out of the contract.

### 3.5 `D1Database` (relational store)

Used by: `indieauth`, `micropub`, `microsub`, `websub`, `vc`, `mastodon-api`,
`webmention`, and the shared GC table (`@dwk/store` `gc.ts`, on behalf of
`solid-pod` / `remotestorage` / `webdav`).

| Member | Required semantics |
| --- | --- |
| `prepare(sql)` | Prepare one statement with `?` placeholders. |
| `stmt.bind(...values)` | Positional binding; returns a bound statement. |
| `stmt.first<T>()` | First result row as an object, or `null` when the result set is empty. |
| `stmt.all<T>()` | `{ results: T[], meta }`. |
| `stmt.run()` | Execute without materializing rows: `{ success, meta }`; **`meta.changes`** MUST report the number of rows the statement changed (the packages branch on it for `INSERT OR IGNORE` dedup and conditional updates). |
| `batch(stmts)` | Execute the prepared statements **atomically and in order** (all-or-nothing, as in D1); returns one result envelope per statement, each with its own `meta.changes`. |
| `exec(sql)` | Execute a string of one or more `;`-separated statements (the packages collapse schema DDL to a single line before calling it). |

**Dialect:** SQLite, exactly as §3.2 (the packages share `PRAGMA table_info`
migration idioms across D1 and DO-SQLite).

**Consistency:** read-your-writes — a query issued after a completed write on
the same binding MUST observe that write. On Cloudflare this is D1's
session-consistency mode ([non-functional-requirements.md](non-functional-requirements.md));
a single local SQLite file is strictly stronger and conforms.

**Not required:** `raw()`, `withSession()`, `dump()`, `meta` fields beyond
`changes`.

### 3.6 Queues (producer + batch consumer)

Producers: `@dwk/webmention` (async verification), `@dwk/microsub` (poll jobs),
`@dwk/websub` (distribute + per-subscriber deliver jobs). Consumers: the
exported factories in the same packages (`createWebmentionQueueConsumer`,
`createMicrosubQueueConsumer`, `@dwk/websub`'s consumer), which the composed
Worker wires to its `queue` entry point.

| Member | Required semantics |
| --- | --- |
| `queue.send(body)` | Enqueue one message. Bodies are JSON-shaped plain values and MUST round-trip structured serialization intact. |
| `queue.sendBatch(entries)` | Enqueue `{ body }` entries; MUST accept batches at least as large as Cloudflare's limits (100 messages / 256 KiB) — the producers already self-chunk to stay inside those. |
| `batch.messages` | The delivered messages. |
| `message.body` | The deserialized body. |
| `message.attempts` | Delivery attempt counter, starting at 1 and incremented on each redelivery — the consumers compute their retry backoff and give-up caps from it. |
| `message.ack()` | Marks this message consumed; an acked message MUST NOT be redelivered. |
| `message.retry({ delaySeconds })` | Requests redelivery no sooner than roughly `delaySeconds` later. |

**Delivery semantics:** at-least-once and durable — a message that was
`send`-acknowledged MUST survive a host restart and MUST eventually be
delivered (and redelivered) until acked. A message neither acked nor retried
when the consumer invocation ends (including by throwing) MUST be redelivered.
Ordering is NOT guaranteed and duplicates are permitted; the consumers are
written to tolerate both. A host SHOULD apply a bounded redelivery cap /
dead-letter policy as a backstop, but the consumers self-limit via `attempts`
and never rely on a DLQ existing.

**Not required:** `ackAll()`, `retryAll()`, `batch.queue`, per-message
`contentType`, `delaySeconds` on `send`/`sendBatch`.

### 3.7 Cron / `scheduled`

Used by: `@dwk/microsub` (the feed poller) and the R2 GC handlers
(`@dwk/solid-pod`, `@dwk/remotestorage`, driving `@dwk/store`'s GC).

The host MUST invoke each registered `scheduled` handler
(`(controller, env, ctx) => Promise<void>`) on its configured cadence while the
host is running. The handlers currently read **no** fields off the controller,
so a minimal `ScheduledController` shape (`scheduledTime`, `cron`) suffices.
Missed ticks (host down, previous run still in flight) MAY be coalesced — the
handlers are idempotent by design. Exact cron-expression syntax is a host
configuration concern, not part of this contract (the Node host takes an
interval; `wrangler` takes a cron expression).

### 3.8 `ExecutionContext`

Handlers receive a `ctx` whose shape includes `waitUntil(promise)` and
`passThroughOnException()`. **No production package calls either** — and per §8
they MUST NOT start to. A host MUST pass an object with those members present
(they MAY be inert no-ops); it MUST NOT require packages to call `waitUntil`
for background work to complete.

## 4. Consistency summary

A conforming host, like the Cloudflare stack it emulates, MUST make all
authoritative state strongly consistent
([non-functional-requirements.md](non-functional-requirements.md)):

| Store | Required guarantee |
| --- | --- |
| DO SQLite (§3.2–3.3) | Serialized per object id; `transactionSync` atomicity. |
| R2 (§3.4) | Read-after-write. |
| D1 (§3.5) | Read-your-writes; atomic `batch`. |
| Queues (§3.6) | Durable, at-least-once. |

A host whose backing store is eventually consistent for any of these does not
conform, regardless of interface fidelity.

## 5. Module resolution

The bare specifier **`cloudflare:workers` MUST resolve** — via the runtime
itself (`workerd`), a loader hook (the Node host's `module.register` hook), or
a bundler alias — and MUST export at least the `DurableObject` base class: a
constructor taking `(ctx, env)` that exposes them to subclasses as `this.ctx` /
`this.env`. This is the **only** runtime import from that module, in exactly
the five DO files listed in §3.3. (Two `test-harness.ts` files also import it;
they are excluded from published builds and from this contract.)

## 6. Required globals (beyond the Web baseline)

| Global | Required by | Contract |
| --- | --- | --- |
| `WebSocketPair` | `solid-pod`, `atproto-pds` | `new WebSocketPair()` yields a connected client/server pair; the server end is passed to `ctx.acceptWebSocket`, the client end is returned as `new Response(null, { status: 101, webSocket: client })`, and the host completes the upgrade when that response reaches the edge (§3.3). |
| `HTMLRewriter` | `webmention`, `indieauth`, `microsub` | The streaming HTML scanner, used as `new HTMLRewriter().on(selector, handlers).transform(response)` with element/text handlers. A WASM build of Cloudflare's `lol-html` (as the Node host installs) conforms. |
| `crypto.DigestStream` | `@dwk/store` (blob hashing) | Cloudflare's non-standard `WritableStream` subclass: `new crypto.DigestStream("SHA-256")` accepts `BufferSource` chunks via `pipeTo`, and its `.digest` property is a `Promise<ArrayBuffer>` of the final hash. Trivially polyfillable (`packages/server/src/crypto-digest-stream.ts`). |

Hosts SHOULD install polyfills idempotently (only when the global is absent) so
running under `workerd` itself is a no-op.

## 7. Explicit non-requirements

A conforming host MAY omit all of the following; production packages MUST NOT
use them (this is what keeps the contract implementable — see §8):

- **`KVNamespace`.** No production package uses KV (the
  [KV-never-for-authz rule](non-functional-requirements.md) held absolutely).
- **`caches` / `caches.default`**, **`request.cf`**, **Email Workers**,
  Analytics Engine, Vectorize, Hyperdrive, Workers AI, browser rendering,
  rate-limiting bindings, Static Assets bindings.
- **`ctx.waitUntil` / `ctx.passThroughOnException`** as behaviour (§3.8) — the
  members must exist, but nothing may depend on them doing anything.
- **R2:** `list`, multipart, `onlyIf` conditionals, range reads.
- **D1:** `raw()`, `withSession()`, `dump()`.
- **Durable Objects:** `blockConcurrencyWhile`, `getAlarm` / `deleteAlarm`,
  `serializeAttachment` / `deserializeAttachment`, `webSocketError`, the
  key-value `storage.get/put/delete/list/deleteAll` API, point-in-time
  recovery, WebSocket auto-response, RPC entrypoints (stubs are used via
  `fetch` only), `idFromString` / `newUniqueId` / `getByName`.
- **Queues:** `ackAll()` / `retryAll()`, `batch.queue`, `contentType`,
  producer-side delays.

Some of these (e.g. `blockConcurrencyWhile`) are implemented by the reference
Node host anyway because they are cheap and conventional; that is a courtesy,
not a requirement.

## 8. Contract growth (binding on package authors)

The contract stays small only if growth is deliberate:

- Production package code MUST NOT use a Cloudflare interface member, module,
  or global not listed in §§3–6. In particular, `ctx.waitUntil` MUST remain
  unused — background work belongs in queues or alarms, which are already in
  the contract.
- A change that genuinely needs new surface MUST, in the same PR: (1) amend
  this spec, (2) implement the surface in the reference Node host
  (`@dwk/server` / `@dwk/cf-shims`), and (3) note the impact on any other
  documented host.
- Reviewers SHOULD treat a new `@cloudflare/workers-types` member appearing in
  a package diff as a contract change, not an implementation detail.

The contract tracks the `@cloudflare/workers-types` version pinned in the repo;
upstream interface changes are absorbed here deliberately, never implicitly
(see [open-questions](portability.md#6-open-questions)).

## 9. Conformance tiers and how a host proves compliance

Not every host needs the whole contract. Tiers, from the per-package binding
inventory:

| Tier | Requires | Packages it can mount |
| --- | --- | --- |
| **0 — stateless** | §2 baseline only | `webfinger`, `host-meta`, `@dwk/esi` assembly, and all pure libs |
| **1 — relational** | Tier 0 + D1 (§3.5), R2 (§3.4), Queues (§3.6), cron (§3.7), `HTMLRewriter` (§6) | `indieauth`, `micropub`, `webmention`, `microsub`, `websub`, `vc`, `mastodon-api` (phase 1) |
| **2 — full (actor)** | Tier 1 + Durable Objects (§3.3), `SqlStorage` (§3.2), `cloudflare:workers` (§5), `WebSocketPair` + `crypto.DigestStream` (§6) | `solid-pod` (incl. `webdav` mounting), `activitypub`, `remotestorage`, `webauthn`, `atproto-pds` |

A host claiming a tier proves compliance with, in increasing strength:

1. **Shim-level parity tests** — unit tests against the host's binding
   implementations asserting the semantics in §§3–4 (the Node host's
   `packages/server/src/shims/*.test.ts` are the model: alarm durability and
   retry, mutex serialization, D1 result envelopes, R2 streaming and metadata
   round-trips, queue redelivery and `attempts`).
2. **Composed integration lifecycles** — boot the host with real packages
   mounted and drive representative end-to-end flows (the model:
   `@dwk/server`'s `phase*-*.integration.test.ts`, e.g. inbound `Follow` +
   alarm-driven delivery retry for `activitypub`, a commit + firehose frame
   over a live WebSocket for `atproto-pds`). The packages' own colocated test
   suites run under `@cloudflare/vitest-pool-workers` and are **not** directly
   reusable against another host; the integration lifecycles are the practical
   substitute.
3. **The hosted conformance suites** — point
   `scripts/conformance/run-suite.mjs --target` at a deployed instance of the
   host (micropub.rocks, webmention.rocks, Solid). Per
   [conformance-and-testing.md](conformance-and-testing.md), a host earns a
   status column of its own; conformance results transfer across hosts only
   because the protocol logic is byte-for-byte shared.

A host that passes (1) and (2) for its tier MAY be documented as **supported**;
(3) is the bar the project holds before recommending a host for production use
(the same bar the Cloudflare target itself is held to by the release gate).

## 10. Reference links

- [portability.md](portability.md) — the investigation this contract
  formalizes; [self-hosting.md](self-hosting.md) — the first alternative host's
  design; [composition-contract.md](composition-contract.md);
  [non-functional-requirements.md](non-functional-requirements.md).
- Reference host implementation: `packages/server/src/shims/` (the
  `@dwk/cf-shims` extraction candidate), plus
  `packages/server/src/cloudflare-workers-loader.ts` (§5),
  `packages/server/src/html-rewriter.ts` and
  `packages/server/src/crypto-digest-stream.ts` (§6).
- Cloudflare's documentation of the emulated originals:
  [D1 client API](https://developers.cloudflare.com/d1/worker-api/) ·
  [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) ·
  [Durable Objects](https://developers.cloudflare.com/durable-objects/) ·
  [DO SQL storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/) ·
  [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) ·
  [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) ·
  [Queues](https://developers.cloudflare.com/queues/) ·
  [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
