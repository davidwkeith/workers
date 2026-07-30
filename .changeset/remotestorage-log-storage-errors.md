---
"@dwk/remotestorage": patch
---

Log an unexpected Durable Object storage error via `console.error` (in the
`@dwk/log` `consoleLogger` record shape) before rethrowing it, instead of the
error vanishing silently — the front door's injected `Logger`/`Metrics`
cannot cross the DO `fetch()` boundary, so this is the only signal available
at that layer.
