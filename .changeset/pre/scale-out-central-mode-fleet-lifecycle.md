---
"@dwk/server": minor
---

Make the `central` storage mode's replica fleet operable (spec/scale-out.md,
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
