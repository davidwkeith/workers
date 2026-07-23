# `@dwk/cf-shims`

Node-backed implementations of the Cloudflare binding interfaces — the
**reference implementation of the
[host contract](../../spec/host-contract.md)**. Extracted from `@dwk/server`'s
shim layer (issue
[#381](https://github.com/davidwkeith/workers/issues/381)) so any Node-shaped
host — `@dwk/server`, a bare `node:http` server, a test harness, a future Deno
host via `node:` compat — can run the `@dwk` packages unchanged without copying
source.

Each shim implements the same TypeScript interface the endpoint packages
already program against:

| Shim | Backing | Contract section |
| --- | --- | --- |
| `createD1Database` | `node:sqlite` file | host-contract §3.5 |
| `createR2Bucket` | filesystem (streaming, etag'd, metadata sidecars) | §3.4 |
| `createKVNamespace` | SQLite (or in-memory) | non-requirement (§7) — provided as a courtesy |
| `QueueBroker` | durable SQLite-backed queue + batch consumer loop | §3.6 |
| `CronScheduler` | interval timer driving `scheduled` handlers | §3.7 |
| `DurableObject` / `createDurableObjectNamespace` | per-id SQLite + per-id async mutex, transactional `SqlStorage`, durable alarms with bounded-backoff retry, hibernation-style WebSockets | §3.2–3.3 |

Plus the module/global requirements of host-contract §5–6:

- **`cloudflare:workers`** — the module stand-in
  (`@dwk/cf-shims/cloudflare-workers`, exporting the `DurableObject` base) and
  `registerCloudflareWorkers()`, a `module.register` loader hook that resolves
  the bare specifier to it at runtime. Bundlers can use a build-time alias to
  the subpath export instead; test runners use a Vitest `resolve.alias`.
- **`installHTMLRewriter()`** — a WASM `lol-html` build installed as the
  `HTMLRewriter` global.
- **`installCryptoDigestStream()`** — Cloudflare's non-standard
  `crypto.DigestStream` on `node:crypto`.
- **`installWebSocketGlobals()`** — `WebSocketPair` and a `webSocket`-carrying
  101 `Response`.

All installers are idempotent (no-ops where a native global already exists,
e.g. under `workerd`).

## Boundary rules

- Imports **Node built-ins only** (`node:sqlite`, `node:fs`, `node:crypto`,
  `node:stream`, `node:module`) plus the `HTMLRewriter` WASM build — no
  Express, no host-runtime imports.
- Requires **Node ≥ 22** (`node:sqlite`; ≥ 24 for flagless stable use).
- **Exactly one process may write a given data directory.** The per-id mutex
  reproduces the Durable Object single-writer guarantee only within a single
  process; enforcing the single-process invariant (e.g. a startup lockfile) is
  the consuming host's job. See `@dwk/server` for the reference enforcement.
- Network bridging is out of scope: this package emulates the in-process
  primitives; accepting real WebSocket upgrades and piping them onto the
  emulated pair is host territory (`@dwk/server`'s `web-socket-upgrade`).

## Consuming

```ts
import {
  createD1Database,
  createR2Bucket,
  QueueBroker,
  CronScheduler,
  createDurableObjectNamespace,
  registerCloudflareWorkers,
  installHTMLRewriter,
  installCryptoDigestStream,
  installWebSocketGlobals,
} from "@dwk/cf-shims";

registerCloudflareWorkers(); // before importing any DurableObject package
installHTMLRewriter();
installCryptoDigestStream();
installWebSocketGlobals();

const env = {
  MY_DB: createD1Database("/data/d1/my-db.sqlite"),
  BLOBS: createR2Bucket("/data/r2/blobs"),
  // …
};
```

See [`spec/packages/cf-shims.md`](../../spec/packages/cf-shims.md) for the
package spec and [`spec/host-contract.md`](../../spec/host-contract.md) for the
normative semantics these implementations satisfy.
