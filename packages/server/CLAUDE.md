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
  instances from corrupting the same data directory.
- **All @dwk packages as devDeps.** The server imports all endpoint packages
  for composition but they're devDependencies since this is never published.

## Test environment

Node (`environment: "node"`). Uses a `cloudflare:workers` module alias pointing
to `@dwk/cf-shims`'s `cloudflare-workers.ts` for Durable Object primitives.

```bash
pnpm test --project @dwk/server
```

## File layout

```
src/index.ts                # public surface: createServer, bindings, adapters,
                             #   plus a re-export of @dwk/cf-shims's shims/seams
src/server.ts                # DwkServer class, Express setup, mount routing
src/cli.ts                   # dwk-serve bin entry + startServer lifecycle
src/config.ts                # HostConfig, Mount, FetchHandler types
src/adapter.ts                # toWebRequest, sendWebResponse (Fetch ↔ Express)
src/bindings.ts               # assembleBindings (shims → Env, on-disk layout)
src/context.ts                # WaitUntilTracker, HostExecutionContext
src/lifecycle.ts              # queue/scheduled handler adapters (bind Env + ctx)
src/lock.ts                   # acquireWriterLock, data directory locking
src/request-duplex.ts         # installRequestDuplex for streaming request bodies
src/web-socket-upgrade.ts     # bridges a real HTTP Upgrade socket to a mount's DO
                              #   (the one shim-adjacent piece that stays here — see above)
src/*.test.ts                 # colocated tests
```

The Cloudflare binding shims and runtime-global polyfills themselves
(`d1.ts`/`r2.ts`/`kv.ts`/`queue.ts`/`cron.ts`/`durable-object.ts`,
`cloudflare-workers.ts`/`cloudflare-workers-loader.ts`, `html-rewriter.ts`,
`crypto-digest-stream.ts`, `web-socket.ts`) live in
[`@dwk/cf-shims`](../cf-shims), not here.

## Dependencies (runtime)

- `@dwk/cf-shims` — the Cloudflare binding shims and runtime-global seams.
- `@dwk/log` — structured logging.
- `express` (5.x) — HTTP server.
- `helmet` — baseline security-header middleware (nosniff, frame-options,
  HSTS, …); CSP left off since `publicDir` can serve an arbitrary self-hosted
  site.
- `ws` — WebSocket implementation (for `web-socket-upgrade.ts`'s real HTTP
  `Upgrade` bridging).
