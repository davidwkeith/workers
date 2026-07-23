# @dwk/server

Node.js/Express self-hosting host — private, never published to npm.

## What this is

Docker-deployable Express server that emulates Cloudflare Workers primitives on
Node.js + SQLite + filesystem. Provides a `Fetch → Express` request adapter,
Node-backed shims for D1 (SQLite), R2 (local filesystem), KV (in-memory),
Durable Objects (per-pod SQLite files, including **alarms** — see below),
queues (Node job scheduler), and cron (scheduled tasks), so any composed set of
`@dwk` endpoint packages can be mounted behind one domain exactly as they would
in a Worker. Its own devDeps exercise all twelve endpoint packages —
`indieauth`/`micropub`/`microsub`/`webmention`/`websub`/`webfinger`/
`host-meta`/`webauthn`/`vc`/`solid-pod`/`activitypub`/`atproto-pds`/
`remotestorage`/`webdav` (plus `store`/`wac`/`ldn`) — each wired into this
host's own composed test app (`src/phase2`–`phase5*.integration.test.ts`).
`activitypub` and `atproto-pds` are Durable Object alarm consumers
(delivery-retry and `did:plc` genesis-retry, respectively) and could not run on
this host at all until the DO shim grew alarm support (#379); `webdav` has no
Durable Object of its own — it is a façade over `SolidPodObject`
(`createSolidPodWebdav`/`createSolidPodWebdavCredentials`, from
`@dwk/solid-pod`), so it is exercised alongside solid-pod's own DO mount.

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
- **DO alarms are real and restart-safe.** `setAlarm`/`getAlarm`/`deleteAlarm`
  persist the scheduled time in the object's own SQLite file and fire through
  a real timer chained onto the same per-id single-writer mutex as `fetch` —
  never concurrently with a request or another alarm on that object. A
  namespace scans its data directory on construction so a pending alarm still
  fires after a restart, even before any request re-touches that id.
- **HTMLRewriter polyfill.** `installHTMLRewriter` patches the global for
  packages that use Cloudflare's HTMLRewriter API.
- **WebSocket polyfill.** `installWebSocketGlobals` + `WebSocketPair` provide
  the Cloudflare WebSocket API shape using the `ws` npm package.
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
