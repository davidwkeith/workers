---
"@dwk/server": minor
---

Bring Durable Objects (Tier 2 — `solid-pod`, `activitypub`, `remotestorage`,
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
