---
"@dwk/activitypub": patch
---

Emit `activitypub.delivery.*` log events for alarm-driven outbound delivery
(and pending-accept inbox resolution) directly via `console.log`/
`console.error`, visible in `wrangler tail`. Previously these events were
defined in the log vocabulary but never emitted anywhere — an alarm-driven
delivery attempt has no HTTP response to hang the front door's
`x-ap-outcome` header off, so success, retryable failure, permanent failure,
and SSRF-blocked targets were completely unobservable in production. Each
line reports the target host, HTTP status, attempt count, and whether the
row was dropped — never activity bodies, keys, or tokens.
