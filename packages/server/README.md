# @dwk/server

Node.js / Express **self-hosting host** for the `@dwk` packages. Run the same
standards implementations you'd deploy to Cloudflare Workers as a single
long-running Node process on a box you own (VPS / homelab / NAS), with static
file hosting alongside the endpoints.

> **Cloudflare first.** Cloudflare Workers remains the primary, recommended
> deployment target; self-hosting is a supported secondary path. This package is
> the Node analogue of "the Worker entry + `wrangler.toml`" a Cloudflare deployer
> writes by hand — packaged and reusable. See
> [`spec/self-hosting.md`](../../spec/self-hosting.md).

## How it works

The composition contract's handler shape —
`(request: Request, env, ctx) => Promise<Response>` — is already Web
Fetch-standard, and Node ≥ 22 implements those globals natively, so **the
protocol logic is already portable**. The only gap is the `Env` bindings and
lifecycle hooks. `@dwk/server` closes that gap:

- an **Express ⇄ Web fetch adapter** that streams bodies both ways (no
  buffering), so uploads and blob downloads stay within the streaming discipline
  the Worker path honours;
- **static hosting** via `express.static` with deterministic routing precedence
  — reserved protocol paths (`/.well-known/*` and each mount's configured paths)
  win over static files, then static, then a configurable fallback hook;
- **Node-backed shims for the Cloudflare binding interfaces**, from
  [`@dwk/cf-shims`](../cf-shims), so the endpoint packages run unchanged:
  `D1Database` → `node:sqlite`, `R2Bucket` → filesystem, `KVNamespace` →
  SQLite/memory, plus an in-process durable **Queue** and a cron/`scheduled`
  timer;
- **lifecycle binding** (`bindQueueConsumer` / `bindScheduledTask`) that adapts
  the packages' Cloudflare-shaped `(batch|controller, env, ctx)` queue consumers
  and `scheduled` handlers onto the broker/scheduler, plus a WASM `HTMLRewriter`
  global (`@dwk/cf-shims`'s `installHTMLRewriter`, installed at startup) so
  packages that scan HTML (webmention verification, microsub feed discovery)
  run on Node;
- **Durable Object emulation** (`@dwk/cf-shims`'s `createDurableObjectNamespace`):
  `SqlStorage` over `node:sqlite`, one object per id behind a per-id mutex (the
  single-writer guarantee) with `blockConcurrencyWhile` gating, plus emulated
  hibernatable **WebSockets** bridged to real client connections over HTTP
  `upgrade` (the `ws` library, in this package's `web-socket-upgrade.ts`) so
  Solid notifications work. The `cloudflare:workers` import is redirected to
  the shim by a `module.register` loader hook (production) or a Vitest alias
  (tests), so `@dwk/webauthn` and `@dwk/solid-pod` run unchanged.

It mirrors how `@dwk/store` confines Cloudflare *storage*: this package
confines the *Node runtime*, composing the Cloudflare-interface emulations
from [`@dwk/cf-shims`](../cf-shims) behind Express — extracted there (#381) so
any Node host can reuse them without copying source.

## Correctness & the single-writer invariant

A single Node process over local SQLite is **strictly serializable** — at least
as strong as the Cloudflare stack it replaces. The one load-bearing invariant is
**exactly one process writes a given data directory**. The host enforces it with
a startup lockfile and refuses a second writer; clustering / HA is out of scope.

## Usage

```ts
import { createServer, assembleBindings } from "@dwk/server";
import { createWebfinger } from "@dwk/webfinger";
import { createIndieAuth } from "@dwk/indieauth";

const baseUrl = "https://example.com"; // identity is HTTPS-rooted
const dataDir = process.env.DWK_DATA_DIR ?? "./data";

// Assemble the Env from Node-backed shims + secrets (the composition root is the
// one place allowed to read the environment). Each binding becomes a store under
// the data dir: D1 → `d1/<NAME>.sqlite`, R2 → `r2/<NAME>/`, KV → `kv/<NAME>.sqlite`.
const env = assembleBindings({
  dataDir,
  d1: ["AUTH_DB"],
  secrets: { TOKEN_SIGNING_KEY: process.env.TOKEN_SIGNING_KEY },
});

const server = createServer({
  baseUrl,
  dataDir,
  publicDir: "./public", // the user's website
  env,
  mounts: [
    {
      name: "@dwk/webfinger",
      handler: createWebfinger({ resources: { /* … */ } }),
      reservedPaths: ["/.well-known/webfinger"],
    },
    {
      name: "@dwk/indieauth",
      handler: createIndieAuth({ baseUrl, approveAuthorization }),
      reservedPaths: ["/authorize", "/token", "/.well-known/oauth-authorization-server"],
      requires: ["AUTH_DB", "TOKEN_SIGNING_KEY"], // asserted at startup (fail loud)
    },
  ],
});

await server.listen(3000);
// later, on SIGTERM: await server.close();  // drains waitUntil work, releases the lock
```

A full reference composition wiring the IndieWeb trio + discovery packages
(`indieauth`, `micropub`, `webmention`, `webfinger`, `host-meta`, `vc`) on the
shims — authenticated DPoP-bound Micropub publishing, media upload to disk, the
Webmention receiver — lives in `src/phase2.integration.test.ts`. The lower-level
shim factories (`createD1Database`, `createR2Bucket`, `createKVNamespace`,
`QueueBroker`, `CronScheduler`) are also exported for bespoke wiring.

## Running it: Docker (primary) or the `dwk-serve` bin

The composition above is a **config module** — the "Worker entry + `wrangler.toml`"
you'd otherwise write by hand. `examples/composition.mjs` is a runnable reference
(WebFinger + WebAuthn over the shims); copy and extend it.

**Docker (the recommended self-host path).** A multi-stage `Dockerfile` builds an
esbuild single-file bundle (the `cloudflare:workers` import is aliased to the
Node shim at build time) and ships it on a minimal Node 24 image — non-root, a
`/data` volume, and a healthcheck:

```sh
docker build -f packages/server/Dockerfile -t dwk-server .
docker run -p 3000:3000 -v dwk-data:/data \
  -e DWK_BASE_URL=https://pod.example dwk-server
```

Point your config at your own composition by rebuilding the bundle
(`pnpm --filter @dwk/server bundle <entry>`); put a TLS-terminating reverse proxy
in front.

**The `bin` (run on the host directly).** `npm i @dwk/server`, write a config
module, and:

```sh
dwk-serve ./composition.mjs --port 3000     # or: PORT, HOST, DWK_CONFIG env vars
```

A reference `systemd` unit (`examples/dwk-serve.service`) hardens it and maps
SIGTERM to a clean drain. On Node 22 `node:sqlite` prints an experimental
warning; Node ≥ 24 runs it flag-free.

## Deploying to AWS, GCP, or any other cloud

There is no AWS- or GCP-native `@dwk` host, and none is planned — the Docker
image above **is** the supported answer for every non-Cloudflare cloud. The
[portability investigation](../../spec/portability.md) looked at native
serverless options (Lambda, Cloud Functions/Run, Fastly Compute, Puter) and
found the container path is the only one that works today without a shim
rewrite: this host needs a **long-lived process** with a **persistent,
single-writer filesystem** (the `acquireWriterLock` invariant above), and that
rules out anything that scales horizontally or wipes local disk between
invocations.

**Works, with no code changes** — anywhere you can run a container with a
mounted volume and keep exactly one instance writing to it:

- **AWS**: ECS or Fargate with an attached EFS (or EBS, single-AZ) volume, or
  plain EC2 running `docker run` directly. Lambda / Lambda@Edge do **not**
  work — no persistent disk, and CloudFront/Lambda@Edge isn't even
  fetch-shaped (spec/portability.md §4.3).
- **GCP**: a GCE VM running the container (with a persistent disk), or a
  single always-on Cloud Run **service with a mounted volume and
  `minInstances`/`maxInstances` pinned to 1** so it never scales out from
  under the SQLite files. Cloud Run's default autoscaling and GCF's ephemeral
  filesystem otherwise break the single-writer invariant (spec/portability.md
  §4.4) — don't use them without pinning to one instance.
- **Anywhere else**: a VPS (DigitalOcean, Hetzner, Linode, …), Fly.io, a
  homelab box, bare metal — same `docker run` + volume + reverse-proxy shape
  as the Docker quickstart above.

```sh
# Same image, same invocation, on any of the above — only the volume and the
# reverse-proxy/TLS setup are provider-specific:
docker run -p 3000:3000 -v dwk-data:/data \
  -e DWK_BASE_URL=https://pod.example dwk-server
```

Put a TLS-terminating reverse proxy or the platform's managed load balancer in
front (identity is HTTPS-rooted — see Security below), and back up the data
volume like any other stateful service: `docker cp`/`tar` the mounted
directory, or a filesystem/volume snapshot. See
[Data portability](#data-portability) below for what's actually inside it, and
[spec/portability.md](../../spec/portability.md) for the full per-provider
feasibility analysis (why Fastly Compute and Lambda@Edge are explicit
non-goals for the stateful packages, and what a future isolate-class host
like Deno Deploy would need).

## Security (you now own what Cloudflare provided)

- **TLS**: identity is HTTPS-rooted, so the host **refuses a non-localhost
  `http://` `baseUrl`** outside `devMode`. Terminate TLS at a reverse proxy
  (Caddy / nginx / Traefik) and set `baseUrl` to your public `https://` origin.
- **DDoS / rate limiting** is now your reverse proxy / firewall's job.
- **SSRF**: `webmention` / `microsub` fetch remote URLs behind the shared
  `safe-fetch` guards — but on a home network an SSRF bypass can reach the LAN,
  so review the allow/deny posture for your network.
- **Filesystem**: the data directory holds keys and all pod data — it is created
  `0700`. Mount it as a private volume and back it up.

## Data portability

`@dwk/cf-shims`'s shims are mechanical mirrors of the Cloudflare stores, so
migration is a copy in either direction: **D1 ⇄ `node:sqlite` file**,
**R2 ⇄ a directory of objects**, **DO-SQLite ⇄ one SQLite file per object id**
(`<dataDir>/do/<class>/<id>.sqlite`). Moving between Cloudflare and self-hosted
is export-then-import, no schema change.

## Status

**Experimental, unreleased (`0.0.0`).** This package implements the host
skeleton + adapter + static hosting and the `waitUntil` lifecycle, and composes
[`@dwk/cf-shims`](../cf-shims)'s D1/R2/KV storage shims, queue/cron scheduler,
and Durable Object emulation (`SqlStorage`, per-id single-writer, **alarms**,
WebSocket hibernation) — enough to run **every** `@dwk` package that ships a
DO: `@dwk/solid-pod`,
`@dwk/webauthn`, `@dwk/activitypub`, `@dwk/atproto-pds`, `@dwk/remotestorage`,
and `@dwk/webdav` (mounted over solid-pod's DO), each exercised end-to-end
against the host in `src/phase5-*.integration.test.ts` — plus the stateless and
D1/R2-backed ones (IndieAuth, Micropub, Webmention, Microsub, WebSub,
WebFinger, host-meta, VC), and the packaging (the `dwk-serve` bin + the esbuild
bundle + Dockerfile). Wiring a Node
conformance column into `conformance/status.json` and publishing versioned image
tags are the remaining self-hosting tasks; the package stays experimental until
its conformance column is green.

## Requirements

Node **≥ 22** (the SQLite shim uses the built-in `node:sqlite`; Node ≥ 24 runs it
flag-free, otherwise `--experimental-sqlite` on 22.x).

## License

ISC
