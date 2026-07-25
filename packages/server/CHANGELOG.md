# @dwk/server

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/cf-shims@1.0.0-beta.1
  - @dwk/deno-host@1.0.0-beta.1
  - @dwk/log@1.0.0-beta.1

## 0.1.0-beta.5

### Minor Changes

- be30ce4: Make the `central` storage mode's replica fleet operable (spec/scale-out.md,
  phase 4 of the horizontal scale-out plan, #433): queue pollers on every
  replica, a cron tick lease so a scheduled handler fires once fleet-wide,
  graceful drain, and health surfaces.

  - `CentralFleetPoller` (`central-fleet-poller.ts`) — `DurableObjectAlarmPoller`
    (#432), renamed and extended: it now also polls every registered
    `@dwk/deno-host` `QueueBroker`'s `pollQueues()` on the same jittered
    per-replica tick as DO alarms and the coordination-KV sweep. Central mode
    always wires the conforming, redeliver-by-default queue broker — never
    `@dwk/cf-shims`'s auto-acking one.
  - `CentralCronScheduler` (`central-cron.ts`) — the central-mode counterpart to
    `@dwk/cf-shims`'s `CronScheduler`: every replica registers the same
    `scheduled` handlers on the same cadence, but each tick first attempts a
    short-lived tick-lease CAS in the coordination KV, so exactly one replica
    runs a given cadence bucket. Structurally compatible with
    `@dwk/cf-shims`'s `ScheduledHandler`, so a package's `scheduled` handler
    runs unchanged.
  - `createCentralHealthMounts` (`central-health.ts`) — liveness (`/healthz`,
    always `200` while the process is up) and readiness (`/readyz`, re-running
    the startup store probes on a short cache) as ordinary `Mount`s a deployer
    spreads into `HostConfig.mounts`.
  - `DwkServer.closeCentral(fleetPollers?)` (`server.ts`) — the central-mode
    graceful drain, in spec order: stop accepting connections → stop the given
    fleet pollers (each already awaits its own in-flight tick) → drain the
    `WaitUntilTracker` → close WebSockets → release the (central-mode) writer-
    lock reference. A separate method from `close()`, which is unchanged and
    still exactly right for local mode.
  - New observability events: `central_fleet.{alarm,queue}_poll_error`,
    `central_fleet.sweep_ok`/`sweep_error`; `central_cron.tick_lease_acquired`/
    `tick_lease_contended`/`claim_error`/`handler_error`;
    `central_do.sync_duration_ms`/`sync_error` (added to
    `createCentralDurableObjectNamespace`'s dispatch path);
    `central_health.probe_failed`/`probe_recovered`.

  Proven with two independent `CentralFleetPoller`/`CentralCronScheduler`
  instances sharing one `LibsqlKv` (`central-fleet-poller.test.ts`,
  `central-cron.test.ts`) — two replicas from the coordination store's point of
  view — covering exactly-once queue delivery, redelivery when a handler never
  decides, and single-winner tick-lease election across cadence buckets, plus a
  `central-fleet.integration.test.ts` proving readiness over real HTTP and a
  `closeCentral` drain on one replica while a peer keeps the fleet operable.

  The docker-compose/k8s reference, `dwk migrate`, live verification, and
  hosted-conformance runs remain phase 5, as originally scoped.

- 10ecb12: Packaging, migration tooling, and verification runbook for `central` storage
  mode (spec/scale-out.md, phase 5 of the horizontal scale-out plan, #434).

  - `dwk-migrate` — a second CLI bin (alongside `dwk-serve`, also exported as
    plain functions from `@dwk/server/migrate`) for mechanical local ↔ central
    data migration: D1/DO-SQLite dump-and-replay (dialect-identical, so it's a
    copy in either direction), streamed R2 object migration preserving
    content-type/custom metadata, pending-alarm lifting/lowering between a
    Durable Object's local SQLite file and the central coordination KV's
    due/by-id indexes (baked into every DO-object migration call, not a
    separate step to forget), and local queue backlog import into the
    coordination KV as due entries. `to-central` auto-discovers bindings by
    scanning `dataDir` the way `bindings.ts` lays it out; `to-local` takes an
    explicit target since central mode has no directory to list.
  - `docker-compose.yml` — the sqld + MinIO + 2-replica reference deployment,
    doubling as the live-verification test bed; both replicas build from
    `examples/central-composition.mjs` via the existing `Dockerfile`
    (parameterized with a new `BUNDLE_ENTRY` build arg), fronted by an nginx
    proxy (`nginx.conf`) with WebSocket session affinity for whichever
    DO-WebSocket path a composition mounts.
  - `k8s-notes.md` — the same topology's Kubernetes adaptation notes
    (`Deployment` vs `StatefulSet`, readiness/liveness probe shape, ingress
    session-affinity annotations, `emptyDir` scratch volumes for the
    embedded-replica cache).
  - `conformance/scale-out-qa.md` — the fillable live-verification checklist
    (spec §14 item 4: libSQL read-your-writes/`batch` atomicity over hrana,
    embedded-replica forwarding under concurrent replicas, the `libsql` native
    module on the container base image, S3 read-after-write, streaming-body
    signing, sqld under sustained multi-writer lease traffic) and the hosted
    conformance run against a ≥2-replica target (item 5).
  - README guidance ("Central mode: horizontal scale-out (experimental)") on
    when — and, more importantly, when _not_ — to reach for central mode over
    the local-mode default, echoed with a one-line pointer from the repo root
    README.

  Central mode remains **experimental, not supported** (host-contract §9)
  until the live-verification checklist and hosted-suite run are actually
  executed and recorded passing against real sqld/MinIO services — this phase
  delivers the runbook and its test bed, not the run itself.

- bd0b8cb: Add the opt-in `central` storage mode (spec/scale-out.md, phase 2 of the
  horizontal scale-out plan, #431): `HostConfig.storage` now takes
  `{ mode: "central", kv, objectStore? }` alongside the default
  `{ mode: "local" }`, so N stateless replicas can share centralized D1/R2
  stores instead of local SQLite files.

  - `assembleCentralBindings(spec)` — the `central`-mode counterpart to
    `assembleBindings`: D1 bindings over `@dwk/deno-host`'s `createD1Database`
    (one injected `LibsqlClientLike` per binding), R2 bindings over
    `createS3Bucket` (an injected `S3ClientLike` + endpoint per binding), and KV
    bindings always backed in-memory per replica (KV is only ever a
    safe-to-be-stale cache, so centralizing it buys nothing).
  - `assertNoLocalStores`, `assertModeMarker`, and `probeCentralStores`
    (`central-mode.ts`) — the mode guard and fail-loud startup invariants that
    replace the local-writer lockfile for central mode: `createServer` skips
    `acquireWriterLock` entirely and refuses a `dataDir` still holding
    local-mode stores; the deployer runs the marker check and a round-trip
    probe of every configured store before serving, so an unreachable store is
    a clear startup error rather than a first-request 500.

  Durable Objects across replicas (Tier 2) and the queue/cron poller lifecycle
  are explicitly out of scope for this phase (spec/scale-out.md §15 phases 3–4).

- 43f5d48: Bring Durable Objects (Tier 2 — `solid-pod`, `activitypub`, `remotestorage`,
  `webauthn`, `atproto-pds`) up in `central` storage mode across replicas
  (spec/scale-out.md, phase 3 of the horizontal scale-out plan, #432).

  - `createCentralDurableObjectNamespace(ctor, options)` — the `central`-mode
    counterpart to composing `@dwk/deno-host`'s `createDurableObjectNamespace`
    directly: wires the per-id lease over an injected `DenoKvLike` (typically
    `LibsqlKv`) to an injected `getStorageClient(idHex) => EmbeddedReplicaClientLike`
    (a `SyncSqliteDatabaseLike` plus a `sync()` method, e.g. the `libsql`
    package's embedded-replica client), with the sync-before-serve rule baked
    in as a non-optional part of the wrapper: every dispatch calls
    `client.sync()` after the lease is acquired and before the event runs.
    The endpoint packages that ship a Durable Object run **completely
    unmodified** under this — no second `cloudflare:workers` loader hook is
    needed, since their `DurableObject` base class only wires `ctx`/`env` in
    its constructor.
  - `DurableObjectAlarmPoller` — the per-replica jittered interval timer every
    replica MUST run for central-mode alarms to fire at all (unlike
    `@dwk/cf-shims`'s local-mode shim, `@dwk/deno-host`'s namespace never
    auto-arms one): polls every registered namespace's `pollAlarms()` and
    optionally sweeps a coordination store's expired rows on the same tick.
  - A `LeaseContendedError` thrown by a mount's handler now maps to `503` +
    `Retry-After: 1` in the host's dispatch path, instead of falling through to
    a generic `500` — a load balancer retry against the same URL is safe.

  Proven end to end for one representative package
  (`central-do-activitypub.integration.test.ts`: the inbound-`Follow`-to-
  alarm-driven-`Accept` lifecycle across two replicas, driven entirely through
  the real `@dwk/activitypub` package) plus a synthetic multi-replica suite
  (`central-do.integration.test.ts`) covering sync-before-serve, racing writes
  serializing, and crash recovery (a replica that never releases its lease
  frees the id for another after `leaseTtlMs`). The remaining four Tier-2
  packages' own cross-replica lifecycle suites, and the fleet lifecycle items
  (queue poller, cron tick lease, drain, readiness — phase 4), are follow-ups.

### Patch Changes

- 713e3de: Add `@dwk/cf-shims` (#381): Node-backed implementations of the Cloudflare
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

- Updated dependencies [713e3de]
- Updated dependencies [ff698af]
- Updated dependencies [c677f51]
- Updated dependencies [43f5d48]
- Updated dependencies [6bee3fc]
- Updated dependencies [c867873]
- Updated dependencies [139a2a5]
- Updated dependencies [4cd36af]
  - @dwk/cf-shims@0.1.0-beta.0
  - @dwk/deno-host@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- 3e505be: Added a baseline security-header layer (`helmet`, with CSP left off since
  `publicDir` can serve an arbitrary self-hosted site) applied to every
  response, and an explicit `dotfiles: "deny"` policy on `express.static` so a
  dotfile (`.env`, `.git/…`) under `publicDir` is never served regardless of a
  composition's fallback route. `crossOriginResourcePolicy` is relaxed from
  helmet's `same-origin` default to `cross-origin`, since this host composes
  `@dwk` protocols (WebFinger, ActivityPub, IndieAuth) whose discovery documents
  are explicitly meant to be fetched cross-origin by a browser.
- Updated dependencies [3e505be]
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [6d14fc3]
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- b16323f: Add `assembleBindings(spec)` to `@dwk/server` — a declarative, package-agnostic
  helper that builds the shim-backed `Env` for a set of mounted packages under a
  deterministic data-directory layout (`d1/<NAME>.sqlite`, `r2/<NAME>/`,
  `kv/<NAME>.sqlite`) and injects secrets as plain `Env` members. It guards against
  binding names that are unsafe as path components and against two bindings
  colliding on the same `Env` key.

  This completes the Phase 2 self-hosting milestone (the D1/R2/KV storage MVP): the
  IndieWeb trio plus stateless discovery — `indieauth`, `micropub`, `webmention`,
  `webfinger`, `host-meta`, and `vc` — now mount and run end-to-end on
  `node:sqlite` + filesystem. A reference composition / acceptance test exercises
  authenticated DPoP-bound Micropub publishing, a media upload that lands on disk
  and serves back, the Webmention receiver (sync path) enqueuing verification, and
  WebFinger/host-meta resolution through the host.

- 35d4b0d: Phase 3 self-hosting: bring up the async/scheduled packages on the lifecycle
  shims.
  - Add `bindQueueConsumer` / `bindScheduledTask`: adapters that bind the
    assembled `Env` and a fresh waitUntil-tracked `ExecutionContext` to the
    Cloudflare-shaped `(batch|controller, env, ctx)` handlers the packages export,
    so they register with the in-process `QueueBroker` / `CronScheduler` and run
    unchanged. `HostConfig` gains an optional `tracker` so a consumer's/scheduled
    task's background work is drained on shutdown.
  - Add `installHTMLRewriter()` and call it from `createServer`: installs a
    WASM-backed, workerd-compatible `HTMLRewriter` global (the self-contained
    `@worker-tools/html-rewriter` base64 build — nothing fetched at runtime) so
    packages that scan HTML with the runtime's streaming rewriter
    (`@dwk/webmention` link verification, `@dwk/microsub` feed/`h-feed` discovery)
    run on Node.
  - A reference composition / acceptance test wires the real consumers and
    schedulers end-to-end on the shims: a Webmention is received and verified
    asynchronously into the inbox; a Microsub scheduled poll fans out and
    populates a channel timeline; a WebSub `distribute` job delivers an
    HMAC-signed payload to a subscriber; and the R2 GC cron reclaims an orphaned
    blob from the filesystem-R2 shim.

- 40376d2: Phase 4 (part) — Durable Object emulation, and bring up `@dwk/webauthn` on it.
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

- f1f7acc: Complete Phase 4 self-hosting: bring up `@dwk/solid-pod` on the emulated Durable
  Object, including WebSocket notifications.
  - `@dwk/solid-pod` now runs end-to-end through the host on the Node DO emulation:
    LDP create/read/`If-Match`/delete, Solid N3 Patch, WAC (owner allowed,
    non-owner `403`, anonymous `401`), and opaque blob bodies streamed through R2 —
    all driven over real HTTP through `createServer`.
  - WebSocket hibernation is emulated so Solid notification channels work on Node:
    a `WebSocketPair` of linked in-memory sockets, a `Response` that carries a
    `webSocket` + `101` status (both of which Node's `Response` otherwise rejects),
    and a `webSocketMessage`/`webSocketClose` bridge from the DO state. The host
    bridges real client WebSockets to the matching mount's DO over an HTTP
    `upgrade` via the `ws` library, so a subscriber receives change notifications
    when a resource is written. Adds `ws` as a dependency.

  With this, every `@dwk` package — stateless, D1/R2-backed, queue/cron, and
  Durable Object — runs on the self-hosting host.

- b9af330: Phase 5 packaging — make the host installable and runnable.
  - **`dwk-serve` bin / CLI**: `dwk-serve ./composition.js [--port] [--host]` (or
    `$PORT`/`$HOST`/`$DWK_CONFIG`) loads a composition-root config module, registers
    the `cloudflare:workers` loader hook, `createServer` + `listen`s, and wires
    SIGTERM/SIGINT graceful shutdown. `loadConfig` / `startServer` / `parseArgs` /
    `createShutdown` are exported (via `@dwk/server/cli`) for embedding.
  - **Single-file bundle** (`scripts/bundle.mjs`, esbuild): bundles a composition
    entry + the `@dwk` packages it uses into one ESM file, **aliasing
    `cloudflare:workers` to the Node Durable-Object shim at build time** so the
    bundle needs no loader hook.
  - **Docker image** (the primary self-host artifact): a multi-stage `Dockerfile`
    builds the bundle and ships it on a minimal Node 24 image — non-root, a `/data`
    volume, and a healthcheck. A reference `systemd` unit and a runnable example
    composition (`examples/`) accompany it.
  - **Security / docs**: the host already refuses a non-localhost `http://`
    `baseUrl` outside dev mode (identity is HTTPS-rooted); the README documents the
    TLS-at-a-proxy, DDoS, SSRF (LAN blast radius), `0700` data-dir, and
    data-portability (D1 ⇄ SQLite, R2 ⇄ filesystem, DO-SQLite ⇄ per-id file) posture.

  The package stays experimental until a Node conformance column lands in
  `conformance/status.json` and versioned image tags are published.

- 409a864: Add `@dwk/server` — a Node.js/Express self-hosting host for the `@dwk` packages.

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

### Patch Changes

- 959f738: Track the self-hosted Node host as its own conformance target. `conformance/status.json`
  (and its schema) gain a per-target dimension: a top-level `targets` declaration
  (`cloudflare` primary, `node` self-host) and an optional `targets` map on each
  suite/integration block, plus an `@dwk/server` package row. The release gate now
  validates every declared target for stable packages, the report shows the Node
  column, and `run-suite.mjs --target-id node` records hosted results into it. The
  Node host's integration lifecycle is recorded `passing` for the packages the
  `@dwk/server` integration tests bring up end to end; a `docker.yml` workflow
  builds/publishes the image on release. `@dwk/server` stays experimental until its
  hosted conformance column is green.
- 4d28881: Fix the self-host Docker image build. The builder ran `pnpm --filter @dwk/server
build`, which only compiles `@dwk/server` and not its workspace dependencies, so
  `tsc` could not resolve `@dwk/log` (and the bundle's other `@dwk/*` deps had no
  `dist`). It now runs `pnpm build` (all packages) before bundling. Verified by
  building the image and running it end to end — boots, the WebAuthn Durable Object
  answers through the aliased shim, and SIGTERM exits cleanly. Also drops the
  `useradd --system` UID warning and adds a build-only `docker.yml` check on PRs
  that touch the image inputs, so this can't regress (the workflow otherwise only
  runs on release).
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
