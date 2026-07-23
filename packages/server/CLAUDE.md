# @dwk/server

Node.js/Express self-hosting host — private, never published to npm.

## What this is

Docker-deployable Express server that emulates Cloudflare Workers primitives on
Node.js + SQLite + filesystem. Provides a `Fetch → Express` request adapter,
Node-backed shims for D1 (SQLite), R2 (local filesystem), KV (in-memory),
Durable Objects (per-pod SQLite files, including alarms), queues (Node job
scheduler), and cron (scheduled tasks), so any composed set of `@dwk` endpoint
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
- **HTMLRewriter polyfill.** `installHTMLRewriter` patches the global for
  packages that use Cloudflare's HTMLRewriter API.
- **WebSocket polyfill.** `installWebSocketGlobals` + `WebSocketPair` provide
  the Cloudflare WebSocket API shape using the `ws` npm package.
- **`crypto.DigestStream` polyfill.** `installCryptoDigestStream` patches the
  global for `@dwk/store`'s streamed blob-hashing path (`node:crypto`-backed).
- **All @dwk packages as devDeps.** The server imports all endpoint packages
  for composition but they're devDependencies since this is never published.

## Test environment

Node (`environment: "node"`). Uses a `cloudflare:workers` module alias pointing
to `./src/cloudflare-workers.ts` for Durable Object primitives.

```bash
pnpm test --project @dwk/server
```

## File layout

```
src/index.ts                     # public surface: createServer, bindings, adapters, shims
src/server.ts                    # DwkServer class, Express setup, mount routing
src/cli.ts                       # dwk-serve bin entry + startServer lifecycle
src/config.ts                    # HostConfig, Mount, FetchHandler types
src/adapter.ts                   # toWebRequest, sendWebResponse (Fetch ↔ Express)
src/bindings.ts                  # assembleBindings (shims → Env, on-disk layout)
src/context.ts                   # WaitUntilTracker, HostExecutionContext
src/lifecycle.ts                 # queue/scheduled handler adapters (bind Env + ctx)
src/lock.ts                      # acquireWriterLock, data directory locking
src/html-rewriter.ts             # installHTMLRewriter polyfill
src/request-duplex.ts            # installRequestDuplex for streaming request bodies
src/web-socket.ts                # installWebSocketGlobals, WebSocketPair
src/web-socket-upgrade.ts        # bridges real HTTP Upgrade sockets to a mount's DO
src/crypto-digest-stream.ts      # installCryptoDigestStream polyfill
src/cloudflare-workers.ts        # cloudflare:workers module shim
src/cloudflare-workers-loader.ts # registerCloudflareWorkers ESM loader hook
src/shims/                       # Node-backed binding shims (D1, R2, KV, DO, queue, cron)
src/*.test.ts                    # colocated tests
```

## Dependencies (runtime)

- `@dwk/log` — structured logging.
- `@worker-tools/html-rewriter` — HTMLRewriter polyfill.
- `express` (5.x) — HTTP server.
- `helmet` — baseline security-header middleware (nosniff, frame-options,
  HSTS, …); CSP left off since `publicDir` can serve an arbitrary self-hosted
  site.
- `ws` — WebSocket implementation.
