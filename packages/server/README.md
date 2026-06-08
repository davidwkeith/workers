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
- **Node-backed shims for the Cloudflare binding interfaces** so the endpoint
  packages run unchanged: `D1Database` → `node:sqlite`, `R2Bucket` → filesystem,
  `KVNamespace` → SQLite/memory, plus an in-process durable **Queue** and a
  cron/`scheduled` timer.

It mirrors how `@dwk/store` confines Cloudflare *storage*; this package confines
the *Node runtime and the Cloudflare-interface emulation*. The shims live behind
a clean, Express-free boundary (`@dwk/server` → `./shims`) so a later
`@dwk/cf-shims` extraction is mechanical.

## Correctness & the single-writer invariant

A single Node process over local SQLite is **strictly serializable** — at least
as strong as the Cloudflare stack it replaces. The one load-bearing invariant is
**exactly one process writes a given data directory**. The host enforces it with
a startup lockfile and refuses a second writer; clustering / HA is out of scope.

## Usage

```ts
import {
  createServer,
  createD1Database,
  createR2Bucket,
  QueueBroker,
} from "@dwk/server";
import { createWebfinger } from "@dwk/webfinger";
import { createIndieAuth } from "@dwk/indieauth";

const dataDir = process.env.DWK_DATA_DIR ?? "./data";

// Assemble the Env from Node-backed shims + secrets (the composition root is the
// one place allowed to read the environment).
const env = {
  AUTH_DB: createD1Database(`${dataDir}/auth.sqlite`),
  TOKEN_SIGNING_KEY: process.env.TOKEN_SIGNING_KEY!,
};

const server = createServer({
  baseUrl: "https://example.com", // identity is HTTPS-rooted
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
      handler: createIndieAuth({ baseUrl: "https://example.com", approveAuthorization }),
      reservedPaths: ["/authorize", "/token", "/.well-known/oauth-authorization-server"],
      requires: ["AUTH_DB", "TOKEN_SIGNING_KEY"], // asserted at startup (fail loud)
    },
  ],
});

await server.listen(3000);
// later, on SIGTERM: await server.close();  // drains waitUntil work, releases the lock
```

Put a reverse proxy (Caddy / nginx / Traefik) in front for TLS; DDoS / rate
limiting is now your concern, not the platform's. The data directory holds keys
and pod data — it is created `0700`; back it up.

## Status

**Experimental, unreleased (`0.0.0`).** This package currently implements the
host skeleton + adapter + static hosting, the D1/R2/KV storage shims, and the
queue/cron/`waitUntil` lifecycle shims — enough to run the stateless and
D1/R2-backed packages (IndieAuth, Micropub, Webmention, Microsub, WebSub,
WebFinger, host-meta, VC). Durable Object emulation (for `solid-pod` /
`webauthn`) and the Docker image / CLI are tracked in the self-hosting issue
series.

## Requirements

Node **≥ 22** (the SQLite shim uses the built-in `node:sqlite`; Node ≥ 24 runs it
flag-free, otherwise `--experimental-sqlite` on 22.x).

## License

ISC
