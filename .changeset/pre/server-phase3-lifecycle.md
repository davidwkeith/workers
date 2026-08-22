---
"@dwk/server": minor
---

Phase 3 self-hosting: bring up the async/scheduled packages on the lifecycle
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
