# @dwk/server

Node.js/Express self-hosting host — private, never published to npm.

## What this is

Docker-deployable Express server that emulates Cloudflare Workers primitives on
Node.js + SQLite + filesystem. Provides a `Fetch → Express` request adapter,
Node-backed shims for D1 (SQLite), R2 (local filesystem), KV (in-memory),
Durable Objects (per-pod SQLite files), queues (Node job scheduler), and cron
(scheduled tasks). Mounts all `@dwk` endpoint packages behind one domain,
exactly as a composed Worker would.

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
src/index.ts              # public surface: createServer, bindings, adapters, shims
src/server.ts             # DwkServer class, Express setup, mount routing
src/config.ts             # HostConfig, Mount, FetchHandler types
src/adapter.ts            # toWebRequest, sendWebResponse (Fetch ↔ Express)
src/bindings.ts           # assembleBindings (D1, R2, KV, DO, queue, cron)
src/context.ts            # WaitUntilTracker, HostExecutionContext
src/queue.ts              # QueueBroker, queue consumer binding
src/cron.ts               # CronScheduler, scheduled task binding
src/d1.ts                 # createD1Database (node:sqlite backed)
src/r2.ts                 # createR2Bucket (filesystem backed)
src/kv.ts                 # createKVNamespace (in-memory)
src/durable-object.ts     # DurableObject base, createDurableObjectNamespace
src/lock.ts               # acquireWriterLock, data directory locking
src/html-rewriter.ts      # installHTMLRewriter polyfill
src/request-duplex.ts     # installRequestDuplex for streaming request bodies
src/websocket.ts          # installWebSocketGlobals, WebSocketPair
src/cloudflare-workers.ts # cloudflare:workers module shim
src/resolve.ts            # resolve, registerCloudflareWorkers
src/*.test.ts             # colocated tests
```

## Dependencies (runtime)

- `@dwk/log` — structured logging.
- `@worker-tools/html-rewriter` — HTMLRewriter polyfill.
- `express` (5.x) — HTTP server.
- `ws` — WebSocket implementation.
