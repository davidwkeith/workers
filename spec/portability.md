# Multi-provider portability (investigation & feasibility)

> **Status: investigation — findings and a recommendation, nothing adopted.**
> This document answers
> [issue #369](https://github.com/davidwkeith/workers/issues/369): can the
> `@dwk` packages run on cloud-function providers other than Cloudflare
> Workers — Fastly Compute, Deno Deploy, AWS Lambda@Edge, Google Cloud
> Functions, Puter — "with the core logic the same and the cloud function
> interface being a generic wrapper"? It changes no runtime code. It builds
> on, and reaches the same architectural conclusion as, the self-hosting
> study ([self-hosting.md](self-hosting.md)), which already shipped a second
> runtime (`@dwk/server`, Node/Express).

## 1. TL;DR

- **Feasible in principle, and the repo is already structured for it** — but
  the right mechanism is **not** a new generic wrapper/abstraction inside the
  packages. It is the strategy `@dwk/server` already proved: **treat the
  Cloudflare binding interfaces as the portable contract and re-implement
  them per host** ([self-hosting.md §3](self-hosting.md)).
- **Feasibility differs sharply per provider**, and the discriminator is the
  load-bearing consistency rule
  ([non-functional-requirements.md](non-functional-requirements.md)):
  authoritative state MUST live in strongly-consistent storage, and the
  stateful packages additionally need a single-writer actor (Durable Object
  equivalent) with transactional SQL, alarms, and WebSockets.
  - **Viable today, near-zero new work:** any provider that can run a
    long-lived container with a persistent disk (AWS ECS/EC2, GCE, a VPS,
    Fly.io, …) via the existing `@dwk/server` Docker image.
  - **Most credible isolate-class target:** Deno Deploy (strongly-consistent
    Deno KV, native fetch handler, Node compat) — but its lack of server-side
    SQLite and of a per-key single-writer primitive makes the DO emulation a
    real project.
  - **Not viable for the stateful cohort:** Fastly Compute (KV store is
    eventually consistent — exactly what the consistency rule forbids),
    Lambda@Edge (not fetch-shaped, no state, no WebSockets, hard limits),
    Puter (no documented consistency guarantees, no SQL, no actor).
- **Recommended next step (Phase 0):** extract the Node shims into a
  reusable `@dwk/cf-shims` package (already contemplated by
  [self-hosting.md](self-hosting.md)), add the missing **DO alarm shim**, and
  wire the not-yet-hosted DO packages (`activitypub`, `atproto-pds`,
  `remotestorage`, `webdav`) into the Node host. That single step makes
  "other providers" mean "anywhere a container runs," which covers most of
  the audience in #369 without touching any endpoint package. **All of it is
  done** (#379, #380, #381) — every DO package now runs on the Node host and
  the shims are extracted into `@dwk/cf-shims`, so the container path
  (§4.3–4.4) is the documented, working answer for AWS/GCP/other-cloud users
  today. Only the host-contract spec (§3) remains.

## 2. What the investigation found in the codebase

### 2.1 The portable surface is already large

- All endpoint handlers are fetch-shaped —
  `createX(config): (request, env, ctx) => Promise<Response>`
  ([composition-contract.md](composition-contract.md)) — and program only
  against WHATWG/Web APIs (`Request`/`Response`, streams, `crypto.subtle`).
  No published package imports `node:*`.
- The pure libs (`@dwk/rdf`, `@dwk/dpop`, `@dwk/wac`, `@dwk/oauth`,
  `@dwk/http-signatures`, `@dwk/safe-fetch`, `@dwk/log`, `@dwk/ldn`,
  `@dwk/calendar`, `@dwk/mcp`, `@dwk/esi`, `@dwk/vc` core, `@dwk/webfinger`,
  `@dwk/host-meta`) have **no Cloudflare surface at all**.
- Several tempting-but-unportable Workers features are **deliberately
  unused**: no `KVNamespace` in any production package (the KV-never rule
  held), no `caches.default`, no `request.cf`, no Email Workers, and —
  notably — **no production call to `ctx.waitUntil`** (it appears only as a
  signature type). The only `cloudflare:workers` import in production code is
  the `DurableObject` base class in the five DO files (the Miniflare
  `test-harness.ts` files in `@dwk/store` and `@dwk/webdav` also import it,
  but those are excluded from the published builds).

### 2.2 The Cloudflare coupling, most-coupled first

1. **Durable Objects — the hard dependency.** Five stateful classes:
   `SolidPodObject` (`packages/solid-pod/src/pod.ts`), `ActivityPubObject`
   (`packages/activitypub/src/object.ts`), `AtprotoRepoObject`
   (`packages/atproto-pds/src/object.ts`), `RemoteStorageObject`
   (`packages/remotestorage/src/storage.ts`), `WebAuthnObject`
   (`packages/webauthn/src/rp.ts`). Between them they rely on: per-id
   single-threaded execution, transactional SQLite (`state.storage.sql`,
   `transactionSync`), **alarms** (`setAlarm`/`alarm()` — activitypub
   delivery retries, atproto-pds PLC genesis retries), and **hibernatable
   WebSockets** (solid-pod notifications, the atproto firehose).
2. **R2** — streaming object storage. `@dwk/store` streams strictly
   (content-addressed staging via Cloudflare's non-standard
   `crypto.DigestStream`, `packages/store/src/store.ts` — the one
   non-WHATWG Web API in the tree; trivially polyfillable); `@dwk/micropub`
   streams media; `@dwk/atproto-pds` buffers small blobs.
3. **D1** — plain SQL, the most portable layer (indieauth, micropub,
   microsub, websub, vc, mastodon-api, webmention inbox, GC).
4. **Queues + cron** — websub/microsub/webmention producers + batch
   consumers; scheduled GC and polling.
5. **KV / caches / request.cf / email** — unused; nothing to port.

Note the confinement principle held only partially: `@dwk/solid-pod` and
`@dwk/remotestorage` go through `@dwk/store`, but `atproto-pds`,
`activitypub`, `webauthn` own raw DO-SQLite schemas and `micropub`,
`websub`, `webdav`, `atproto-pds` use R2 directly. That is fine under the
emulation strategy (§3) — the *interfaces* are the seam, not `@dwk/store`.

### 2.3 `@dwk/server` is the existence proof

The Node host re-implements the full binding surface via
[`@dwk/cf-shims`](../packages/cf-shims) (extracted from `@dwk/server`'s
internal `./shims` in #381, per the "mechanical" extraction
[self-hosting.md](self-hosting.md) planned): D1 and DO-SQLite on `node:sqlite`,
R2 on the filesystem (streaming, etag'd, metadata sidecars), KV, a durable
SQLite-backed queue broker, a cron scheduler, an `HTMLRewriter` polyfill, a
`crypto.DigestStream` polyfill, `WebSocketPair`/hibernatable-`WebSocket`
globals, and a `cloudflare:workers` module alias. The shims import nothing
from Express, so any Node host can compose them — `@dwk/server` adds
`waitUntil` tracking and the real hibernatable-WebSocket-to-HTTP-`Upgrade`
bridging on top.

**Known gaps in the Node host today** (they gate Phase 0):

- ~~No DO alarm shim~~ — **resolved** (#379): alarms are emulated (persisted
  in the per-object SQLite file, delivered through the per-id mutex, retried
  with bounded backoff, re-armed on startup).
- ~~`activitypub`, `atproto-pds`, `remotestorage`, `webdav` are not wired into
  the host's composition/tests~~ — **resolved** (#380): all four are now
  devDeps of `@dwk/server` with a `phase5-*.integration.test.ts` per package
  driving a representative lifecycle through the real emulated DO — inbound
  `Follow` + alarm-driven `Accept` delivery/retry for activitypub, a record
  commit + firehose (`subscribeRepos`) frame over a real WebSocket upgrade for
  atproto-pds, a PUT/GET/DELETE + GC-cron lifecycle for remotestorage, and an
  app-password mint + PUT/LOCK/UNLOCK/COPY/MOVE lifecycle for webdav over
  solid-pod. Wiring webdav's `COPY`/`MOVE` surfaced one real gap, since fixed:
  `@dwk/store`'s streamed blob-hashing path depends on Cloudflare's
  non-standard `crypto.DigestStream`, now polyfilled
  (`packages/cf-shims/src/crypto-digest-stream.ts`) on `node:crypto`.
- Cron takes an interval in ms, not a cron expression.
- Single-process, single-writer by design (lockfile) — no HA.

## 3. The "generic wrapper" question — recommendation

Issue #369 proposes "core logic the same, cloud function interface a generic
wrapper." The investigation recommends **rejecting the generic-wrapper
architecture and reaffirming the interface-emulation strategy** that
[self-hosting.md §3](self-hosting.md) already decided:

- A provider-neutral storage/actor abstraction would have to be threaded
  through 14 endpoint packages plus `@dwk/store`, re-tested everywhere, and
  would end up isomorphic to the Cloudflare interfaces anyway — they are
  already narrow, typed, and Web-standard-adjacent (`SqlStorage`, a subset
  of `R2Bucket`/`D1Database`, `Queue`, the `DurableObject` lifecycle).
- The fetch handler `(request, env, ctx) => Promise<Response>` **is** the
  generic wrapper. It is the WinterTC-style signature that Deno Deploy runs
  natively and every other candidate can adapt to.
- Emulation is proven: `@dwk/server` runs the packages unmodified. A second
  emulation host validates the contract far more cheaply than a refactor of
  every package.

What *should* be written down is a **host contract**: a short spec listing
exactly what a conforming host must provide — the binding interfaces and the
subset of their semantics the packages actually rely on (single-writer DOs,
`transactionSync`, alarms, hibernatable WebSockets, streaming R2 bodies,
read-your-writes D1, at-least-once queues, cron), plus the module alias for
`cloudflare:workers` and polyfills for `crypto.DigestStream`/`HTMLRewriter`.
The §2 inventory is effectively its first draft.

## 4. Provider-by-provider feasibility

Requirements shorthand used below — a host needs: **(F)** fetch-shaped
runtime, **(S)** strongly-consistent authoritative storage, **(A)**
per-key single-writer actor with transactional SQL + alarms, **(W)**
server-terminated WebSockets, **(O)** streaming object store, **(Q)**
queues + cron.

| Provider | F | S | A | W | Verdict |
| --- | --- | --- | --- | --- | --- |
| Any Docker host (VPS, ECS/EC2, GCE, Fly.io…) via `@dwk/server` | ✅ | ✅ (local SQLite) | ✅ | ✅ | **Viable now** — finish Phase 0 |
| Deno Deploy | ✅ native | ✅ (Deno KV) | ❌ no actor / no SQLite | ✅ | **Feasible with significant work** |
| Google Cloud (GCF gen2 / Cloud Run) | adapter needed | ⚠️ ephemeral FS; Firestore/Cloud SQL | ❌ | ⚠️ | **Native host infeasible without shim rewrite; use the container path on a VM** |
| Fastly Compute | ~ (WASM SDK) | ❌ KV **eventually consistent** | ❌ | ❌ | **Not viable for stateful cohort** |
| AWS Lambda@Edge | ❌ event-JSON shape | ❌ | ❌ | ❌ | **Not viable; wrong tier of the CDN** |
| Puter | ~ router API | ❓ undocumented | ❌ | ❓ | **Not viable for authoritative state today** |

### 4.1 Deno Deploy — the credible isolate target

Native fetch handlers, WebSockets, `Deno.cron`, Deno Queues, and Deno KV
with external (strongest-form) consistency and atomic transactions; plus
`node:` specifier compatibility, so parts of the existing shims could port.
Two genuine gaps:

1. **No server-side SQLite.** The DO and D1 shims are built on
   `node:sqlite`; the packages issue raw SQL, so a KV re-implementation is
   off the table. The plausible design is external per-object libSQL/Turso
   databases (strongly consistent at the primary) behind the `SqlStorage`/
   `D1Database` interfaces — which reintroduces a third-party dependency and
   deserves its own consistency review.
2. **No per-key single-writer primitive.** Serialized access per pod/actor
   would need a lease/mutex built on Deno KV atomic operations, and alarm
   emulation on `Deno.cron`/queue delays.

Effort: a real project (rough order: several weeks), justified only by
demonstrated demand. Deno's platform is also evolving quickly — re-verify
its primitives (KV availability tiers, the newer Deploy platform) before
committing.

### 4.2 Fastly Compute — blocked on consistency

The Compute KV store is **eventually consistent** — precisely what
[non-functional-requirements.md](non-functional-requirements.md) forbids for
authoritative state — and there is no SQL store, no actor primitive, and no
server-terminated WebSocket story in the Compute runtime. Only the
fully-stateless packages (`webfinger`, `host-meta`, `@dwk/esi` fragment
assembly) could run meaningfully. Not worth a host package; revisit only if
Fastly ships a strongly-consistent store.

### 4.3 AWS — Lambda@Edge is the wrong target; containers work today

Lambda@Edge is a CDN-customization tier, not an app runtime: CloudFront
event-JSON (not fetch), no WebSockets, tight viewer-trigger limits, no
persistent state. It cannot front this architecture. The realistic AWS
mappings are (a) **the `@dwk/server` container on ECS/Fargate/EC2 with a
persistent volume — works after Phase 0**, or (b) a native serverless host
(Lambda function URLs + DynamoDB/Aurora) — a large shim rewrite with a new
single-writer design on conditional writes; not recommended without strong
demand.

### 4.4 Google Cloud — same shape as AWS

GCF gen2 / Cloud Run run Node, so the handlers themselves run — but the
filesystem is ephemeral and instances scale horizontally, which breaks the
SQLite/file-backed shims and the single-writer lockfile invariant (and GCS
FUSE is not safe for SQLite). A native host would mean Firestore- or
Cloud-SQL-backed shims (Firestore is strongly consistent with transactions,
so it passes the consistency bar) — again a large rewrite. The pragmatic
answer is the Docker image on a GCE VM.

### 4.5 Puter — revisit later

JS workers with a router API plus KV and object storage, but no published
consistency guarantees, no SQL, and no actor primitive. Under the
consistency rule it cannot hold authoritative state today. Worth a periodic
re-check; the audience overlap with IndieWeb self-hosters is real.

## 5. Recommended path

1. **Phase 0 — make the existing second runtime complete and reusable**
   (small/medium; no endpoint package changes):
   - ~~Implement the **DO alarm shim** in `@dwk/server`.~~ Done (#379).
   - ~~Wire `activitypub`, `atproto-pds`, `remotestorage`, `webdav` into the
     host's composition and tests.~~ Done (#380).
   - ~~Document "run the Docker image on ECS/GCE/a VPS" as the supported
     answer for AWS/GCP/other-cloud users.~~ Done (#380) —
     `packages/server/README.md` §"Deploying to AWS, GCP, or any other
     cloud".
   - ~~Extract `@dwk/cf-shims` per [self-hosting.md](self-hosting.md).~~ Done
     (#381).
   - Remaining: write the **host contract** spec (§3).
2. **Phase 1 (demand-driven) — Deno Deploy host** (`@dwk/deno-host` or
   similar), reusing `@dwk/cf-shims` where `node:` compat allows; resolve
   the SQLite question (likely libSQL) first.
3. **Explicit non-goals for now:** Fastly Compute, Lambda@Edge, and Puter
   hosts for the stateful cohort, for the reasons in §4 — each with a
   documented re-evaluation trigger (a strongly-consistent store; a fetch
   runtime; published consistency guarantees).

## 6. Open questions

- Where does the line sit between "supported host" and "community host"?
  Conformance ([conformance-and-testing.md](conformance-and-testing.md))
  currently contemplates a Node column; each additional host multiplies the
  conformance matrix.
- Should the host contract freeze on today's `@cloudflare/workers-types`
  versions, and how are Cloudflare-side interface changes tracked?
- If Phase 1 happens: is an external libSQL dependency acceptable for a
  project whose thesis is "data and keys live only on infrastructure the
  user owns"?
