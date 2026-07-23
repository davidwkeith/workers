---
"@dwk/cf-shims": minor
"@dwk/server": patch
---

Extract the Node implementations of the Cloudflare binding interfaces from
`@dwk/server`'s shim layer into the new publishable `@dwk/cf-shims` package —
the reference implementation of `spec/host-contract.md` (#381). The package
carries the D1/R2/KV shims, the durable queue broker and cron scheduler, the
Durable Object emulation (per-id mutex, `SqlStorage`, alarms, hibernation-style
WebSockets), the `cloudflare:workers` module stand-in plus its
`module.register` loader hook, and the idempotent `HTMLRewriter` /
`crypto.DigestStream` / `WebSocketPair` global installers. `@dwk/server` now
consumes it via `workspace:*` and re-exports the same names, so its import
surface is unchanged.
