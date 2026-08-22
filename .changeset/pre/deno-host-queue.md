---
"@dwk/deno-host": minor
---

`createQueueBroker(kv, options?)`: durable at-least-once queue emulation for
Deno Deploy (issue #399, host-contract §3.6), built on Deno KV directly —
the new Deno Deploy platform dropped native Deno Queues with no built-in
replacement. `producer(name)` returns a `send`/`sendBatch` binding writing
a due-time-ordered KV entry per message; `consumer(name, handler, options?)`
registers a handler; `pollQueues()` — an exported tick method the composing
app wires to its own periodic trigger (`Deno.cron()` on Deno Deploy, sharing
its cadence with `pollAlarms()`) — atomically claims due entries (so
concurrent polls can't double-deliver) and invokes the handler with a batch.
Per host-contract §3.6, a message neither `ack()`'d nor `retry()`'d when the
handler call ends — including by throwing — is always redelivered (default
exponential backoff, or the delay from an explicit `retry({delaySeconds})`),
which is the contract-conforming behavior and intentionally stricter than
`@dwk/cf-shims`' `QueueBroker` (which auto-acks a quiet return). A
per-consumer `maxAttempts` drops a message past that cap as a dead-letter
backstop. Overrides the demand gate in `deno-deploy-design.md` §6 for this
increment only — #400 (object storage) stays gated.
