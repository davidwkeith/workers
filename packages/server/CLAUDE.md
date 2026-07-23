# @dwk/server

Node.js/Express self-hosting host — private, never published to npm.

## What this is

Docker-deployable Express server that emulates Cloudflare Workers primitives on
Node.js + SQLite + filesystem. Provides a `Fetch → Express` request adapter and
composes the Node-backed binding shims from **`@dwk/cf-shims`** (D1 → SQLite,
R2 → local filesystem, KV, Durable Objects with alarms, the durable queue
broker, and cron — extracted from this package's former `src/shims/` layer,
#381), so any composed set of `@dwk` endpoint packages can be mounted behind
one domain exactly as they would in a Worker.
Its own devDeps exercise every endpoint package that ships a Durable Object —
`indieauth`/`micropub`/`microsub`/`webmention`/`websub`/`webfinger`/
`host-meta`/`webauthn`/`vc`/`solid-pod`/`activitypub`/`atproto-pds`/
`remotestorage`/`webdav`/`store`/`wac`/`ldn` — each with a `phaseN`/`phase5-*`
integration test driving a representative lifecycle through the real emulated
DO (see `src/phase5-*.integration.test.ts`: inbound `Follow` + alarm-driven
`Accept` delivery/retry for activitypub, a record commit + firehose frame for
atproto-pds, a PUT/GET/DELETE + GC-cron lifecycle for remotestorage, and an
app-password mint + PUT/LOCK/UNLOCK/COPY/MOVE lifecycle for webdav over
solid-pod). Wiring webdav's `COPY`/`MOVE` (a streamed `store.putBlob` re-hash)
surfaced one real host gap, since fixed: a `crypto.DigestStream` polyfill
(`src/crypto-digest-stream.ts`, installed by `createServer`) — Cloudflare's
non-standard streaming-hash `WritableStream` `@dwk/store` depends on
(spec/portability.md §2.2).

## Spec

The server follows the same composition contract as Workers deployment
(`spec/composition-contract.md`), but substitutes Node-native implementations
for Cloudflare bindings.

## Key constraints

- **Private package.** `"private": true` — this is never published to npm. It
  ships only as a Docker image.
- **Fetch ↔ Express bridge.** `toWebRequest` converts Express req to standard
  `Request`; `sendWebResponse` streams a standard `Response` back. All `@dwk`
  handlers see the same `(Request, Env, ExecutionContext)` signature.
- **Node 24 required.** Uses built-in `node:sqlite` for D1/DO SQLite emulation.
- **Data directory locking.** `acquireWriterLock` prevents multiple server
  instances from corrupting the same data directory.
- **Runtime polyfills come from `@dwk/cf-shims`.** `installHTMLRewriter`,
  `installWebSocketGlobals` + `WebSocketPair`, and `installCryptoDigestStream`
  are re-exported from `@dwk/cf-shims` and installed by `createServer`; the
  `ws`-backed bridging of real HTTP `upgrade` sockets onto the emulated pairs
  stays here (`src/web-socket-upgrade.ts`).
- **All @dwk packages as devDeps.** The server imports all endpoint packages
  for composition but they're devDependencies since this is never published.

## Test environment

Node (`environment: "node"`). Uses a `cloudflare:workers` module alias pointing
to `../cf-shims/src/cloudflare-workers.ts` for Durable Object primitives.

```bash
pnpm test --project @dwk/server
```

## File layout

```
src/index.ts                     # public surface: createServer, bindings, adapters
                                 #   (+ re-exports of the @dwk/cf-shims surface)
src/server.ts                    # DwkServer class, Express setup, mount routing
src/cli.ts                       # dwk-serve bin entry + startServer lifecycle
src/config.ts                    # HostConfig, Mount, FetchHandler types
src/adapter.ts                   # toWebRequest, sendWebResponse (Fetch ↔ Express)
src/bindings.ts                  # assembleBindings (cf-shims → Env, on-disk layout)
src/context.ts                   # WaitUntilTracker, HostExecutionContext
src/lifecycle.ts                 # queue/scheduled handler adapters (bind Env + ctx)
src/lock.ts                      # acquireWriterLock, data directory locking
src/request-duplex.ts            # installRequestDuplex for streaming request bodies
src/web-socket-upgrade.ts        # bridges real HTTP Upgrade sockets to a mount's DO
src/*.test.ts                    # colocated tests (composition/adapter/integration)
../cf-shims/                     # the binding shims, polyfills, and loader hook
```

## Dependencies (runtime)

- `@dwk/cf-shims` — the Cloudflare-binding shims, polyfills, and loader hook.
- `@dwk/log` — structured logging.
- `express` (5.x) — HTTP server.
- `helmet` — baseline security-header middleware (nosniff, frame-options,
  HSTS, …); CSP left off since `publicDir` can serve an arbitrary self-hosted
  site.
- `ws` — WebSocket implementation.
