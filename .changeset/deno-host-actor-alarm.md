---
"@dwk/deno-host": minor
---

`createDurableObjectNamespace(ctor, options)`: single-writer actor + alarm
emulation for Deno Deploy (issue #398, host-contract §3.3), built on a
per-request Deno KV atomic-CAS lease (bounded-retry contention, throwing
`LeaseContendedError`) rather than a renewed session lease. Alarms are
indexed directly in KV (not the per-id SQLite file) so `pollAlarms()` — an
exported tick method the composing app wires to its own periodic trigger
(`Deno.cron()` on Deno Deploy) — can find due entries with one range scan;
a throwing handler is retried with exponential backoff (matching
`@dwk/cf-shims`' schedule) unless it sets its own new alarm first, which
supersedes the retry. `ctx.acceptWebSocket`/`getWebSockets` is an in-memory
per-instance socket set ported from `@dwk/cf-shims`, with a documented
cross-process limitation on live sockets (spec/packages/deno-host.md).
Overrides the demand gate in `deno-deploy-design.md` §6 for this increment
only — #399 (queues) and #400 (object storage) stay gated.
