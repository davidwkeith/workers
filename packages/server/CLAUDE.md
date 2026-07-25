# @dwk/server

Node.js/Express self-hosting host — private, never published to npm.

## What this is

Docker-deployable Express server that emulates Cloudflare Workers primitives on
Node.js + SQLite + filesystem. Provides a `Fetch → Express` request adapter and
composes the Node-backed Cloudflare binding shims from
[`@dwk/cf-shims`](../cf-shims) (D1, R2, KV, Durable Objects with alarms, queues,
cron) behind Express and static hosting, so any composed set of `@dwk` endpoint
packages can be mounted behind one domain exactly as they would in a Worker.
Its own devDeps exercise every endpoint package that ships a Durable Object —
`indieauth`/`micropub`/`microsub`/`webmention`/`websub`/`webfinger`/
`host-meta`/`webauthn`/`vc`/`solid-pod`/`activitypub`/`atproto-pds`/
`remotestorage`/`webdav`/`store`/`wac`/`ldn` — each with a `phaseN`/`phase5-*`
integration test driving a representative lifecycle through the real emulated
DO (see `src/phase5-*.integration.test.ts`: inbound `Follow` + alarm-driven
`Accept` delivery/retry for activitypub, a record commit + firehose frame for
atproto-pds, a PUT/GET/DELETE + GC-cron lifecycle for remotestorage, and an
app-password mint + PUT/LOCK/UNLOCK/COPY/MOVE lifecycle for webdav over
solid-pod). This suite is also `@dwk/cf-shims`'s de facto integration test —
that package ships the shims, `@dwk/server` is the first host to compose them.

## Spec

The server follows the same composition contract as Workers deployment
(`spec/composition-contract.md`), but substitutes Node-native implementations
for Cloudflare bindings.

## Key constraints

- **Private package.** `"private": true` — this is never published to npm. It
  ships only as a Docker image.
- **`@dwk/cf-shims` is a dependency, not internal code.** The Cloudflare
  binding shims and runtime-global polyfills (`installHTMLRewriter`,
  `installCryptoDigestStream`, `installWebSocketGlobals`/`WebSocketPair`, the
  `cloudflare:workers` module + loader hook) live in `@dwk/cf-shims`
  (`workspace:*`); this package composes them, it does not implement them.
  `web-socket-upgrade.ts` is the one exception that stays here — bridging the
  emulated `WebSocketPair` to a _real_ HTTP `Upgrade` socket is genuinely
  Express/`ws`-specific, not something every `@dwk/cf-shims` consumer needs.
- **Fetch ↔ Express bridge.** `toWebRequest` converts Express req to standard
  `Request`; `sendWebResponse` streams a standard `Response` back. All `@dwk`
  handlers see the same `(Request, Env, ExecutionContext)` signature.
- **Node 24 required.** `@dwk/cf-shims` uses built-in `node:sqlite` for D1/DO
  SQLite emulation.
- **Data directory locking.** `acquireWriterLock` prevents multiple server
  instances from corrupting the same data directory — **local mode only**.
  `HostConfig.storage: { mode: "central" }` (spec/scale-out.md, #431) skips
  the lockfile entirely (replicas are supposed to coexist) and instead runs
  `central-mode.ts`'s mode guard (`assertNoLocalStores`, refusing a `dataDir`
  that still holds local-mode stores) and startup probes
  (`assertModeMarker`/`probeCentralStores`, deployer-invoked before
  `createServer`).
- **Central-mode Durable Objects (Tier 2, spec/scale-out.md §6, #432).**
  `createCentralDurableObjectNamespace` (`central-durable-object.ts`) wraps
  `@dwk/deno-host`'s `createDurableObjectNamespace` with the sync-before-serve
  rule baked in — every dispatch calls the injected embedded-replica client's
  `sync()` after the per-id lease is acquired and before the event runs, via
  `@dwk/deno-host`'s `onLeaseAcquired` hook (added for this issue), logging
  `central_do.sync_duration_ms`/`sync_error` (#433). A `LeaseContendedError`
  from a mount's handler maps to `503` + `Retry-After` in `server.ts`'s
  `dispatch()`, not the generic `500`. `central-fleet-poller.ts`'s
  `CentralFleetPoller` (renamed from `DurableObjectAlarmPoller` when it grew
  queue polling, #433) is the per-replica jittered timer every replica MUST
  run for scheduled alarms and queued messages to be delivered at all —
  unlike `@dwk/cf-shims`' local-mode shims, `@dwk/deno-host`'s namespace and
  queue broker never auto-arm one. The endpoint packages that ship a Durable
  Object run **completely unmodified** under central mode (proven for
  `activitypub`, `central-do-activitypub.integration.test.ts`): their
  `DurableObject` base class still resolves to `@dwk/cf-shims`'s shim via the
  existing `cloudflare:workers` alias, but since that class only wires
  `ctx`/`env` in its constructor, constructing the same class through
  `@dwk/deno-host`'s structurally-compatible namespace works regardless — no
  second loader hook is needed. WebSockets (the Solid notifications endpoint,
  the atproto firehose) are unaffected by storage mode either way —
  `web-socket-upgrade.ts` and the `WebSocketPair`/hibernation globals are
  per-process runtime seams, not storage (spec/scale-out.md §5) — but a live
  socket is still pinned to whichever replica terminated the upgrade; central
  mode's v1 stance (spec/scale-out.md §6.4) is operational, not
  architectural: put session affinity on the load balancer for
  WebSocket-upgrade paths, or keep a DO-WebSocket-heavy mount on a single
  replica if that window is unacceptable. `@dwk/server` takes no runtime
  dependency on the `libsql` npm package — `getStorageClient` is always
  deployer-injected, same posture as every other central-mode seam —
  `libsql-native.smoke.test.ts` is the one file that imports it, as a
  `devDependency`-gated check that the native module loads on Node.
- **Central-mode fleet lifecycle (spec/scale-out.md §7, §12, #433).** Cron:
  `central-cron.ts`'s `CentralCronScheduler` — structurally compatible with
  `@dwk/cf-shims`'s `ScheduledHandler`, so packages' `scheduled` handlers run
  unchanged — ticks each registered schedule on its own cadence (unlike
  `CentralFleetPoller`'s shared ~1s base tick) but first attempts a
  short-lived tick-lease CAS in the coordination KV, so exactly one replica
  runs a given cadence bucket. Health: `central-health.ts`'s
  `createCentralHealthMounts` returns ordinary `Mount`s (`/healthz` liveness,
  `/readyz` readiness re-running `probeCentralStores`, cached) a deployer adds
  to `HostConfig.mounts` like any endpoint package. Drain:
  `DwkServer.closeCentral(fleetPollers?)` (`server.ts`) is a separate method
  from `close()` (which stays local-mode-only, order unchanged) implementing
  spec §12's exact order — stop accepting connections → stop the given
  `CentralFleetPoller`/`CentralCronScheduler` instances (each already awaits
  its own in-flight tick) → drain the `WaitUntilTracker` → close WebSockets →
  release the (always-null in central mode) writer-lock reference.
- **All @dwk packages as devDeps.** The server imports all endpoint packages
  for composition but they're devDependencies since this is never published.
