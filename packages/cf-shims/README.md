# `@dwk/cf-shims`

Node-backed implementations of the **Cloudflare Workers binding interfaces** —
`D1Database`, `R2Bucket`, `KVNamespace`, `Queue`, cron/`scheduled`, and Durable
Objects — plus the runtime-global seams a Worker gets for free and Node does
not (`cloudflare:workers`'s `DurableObject`, `HTMLRewriter`,
`crypto.DigestStream`, hibernatable `WebSocket`s).

Extracted from [`@dwk/server`](../server)'s internal shim layer so any Node
host — `@dwk/server`, a bare `node:http` server, a test harness, a future
Deno-compat host — can reuse them without copying source. See
[`spec/self-hosting.md`](../../spec/self-hosting.md) for the design this
package implements and
[`spec/portability.md`](../../spec/portability.md) for the extraction
rationale.

## What's in here

| Export | Cloudflare interface | Backing |
| --- | --- | --- |
| `createD1Database(path)` | `D1Database` | `node:sqlite` |
| `createR2Bucket(dir)` | `R2Bucket` | filesystem (streaming, ETag'd, metadata sidecar) |
| `createKVNamespace(options)` | `KVNamespace` | SQLite or in-memory `Map` |
| `QueueBroker` | `Queue` (producer + consumer) | SQLite-backed durable in-process queue |
| `CronScheduler` | `scheduled` | a timer, `ScheduledController`-shaped |
| `createDurableObjectNamespace`, `DurableObject` | Durable Objects | `node:sqlite` + a per-id mutex, alarms, WebSocket hibernation |
| `registerCloudflareWorkers`, `resolve` | `cloudflare:workers` (`{ DurableObject }`) | a `module.register` ESM loader hook |
| `installHTMLRewriter` | `HTMLRewriter` | `@worker-tools/html-rewriter` (WASM) |
| `installCryptoDigestStream` | `crypto.DigestStream` | `node:crypto` |
| `installWebSocketGlobals`, `WebSocketPair`, `EmulatedWebSocket`, `responseWebSocket` | `WebSocketPair` / a `Response` carrying a `webSocket` | in-memory, `EventTarget`-based |

Each shim implements the **same TypeScript interface** the endpoint packages
already program against, so a package composed over these shims runs
unchanged.

## Usage

```ts
import { createD1Database, createR2Bucket, createKVNamespace } from "@dwk/cf-shims";

const AUTH_DB = createD1Database("./data/d1/AUTH_DB.sqlite");
const MEDIA = createR2Bucket("./data/r2/MEDIA");
const SESSION_CACHE = createKVNamespace({ location: "./data/kv/SESSION_CACHE.sqlite" });
```

Durable Objects: redirect the `cloudflare:workers` bare specifier before
importing a package that extends it, then build a namespace per DO class:

```ts
import {
  registerCloudflareWorkers,
  createDurableObjectNamespace,
} from "@dwk/cf-shims";
import { SolidPodObject } from "@dwk/solid-pod"; // imports { DurableObject } from "cloudflare:workers"

registerCloudflareWorkers(); // before any DO-package import resolves, or use a bundler alias instead

const env = {};
env.POD = createDurableObjectNamespace(SolidPodObject, {
  dataDir: "./data",
  env,
  className: "SolidPodObject",
});
```

Runtime-global polyfills are opt-in, install-once calls, each a no-op if the
global already exists (e.g. under workerd):

```ts
import {
  installHTMLRewriter,
  installCryptoDigestStream,
  installWebSocketGlobals,
} from "@dwk/cf-shims";

installHTMLRewriter();
installCryptoDigestStream();
installWebSocketGlobals();
```

`installWebSocketGlobals` gives you `WebSocketPair` and a `Response` that can
carry a `webSocket` + status `101`, matching a Durable Object's upgrade
contract. Bridging the emulated socket to a *real* network connection (an
actual HTTP `Upgrade`) is host-specific — `@dwk/server` does this over the `ws`
package — and is not part of this package.

## Requirements

Node **≥ 22** (`node:sqlite`; Node ≥ 24 runs it flag-free, otherwise
`--experimental-sqlite` on 22.x).

## Status

**Experimental, unreleased.** Extracted verbatim from `@dwk/server`'s
`./shims`, which already exercises every export end-to-end via its
`phase*.integration.test.ts` suite against every `@dwk` package that ships a
Durable Object.

## License

ISC
