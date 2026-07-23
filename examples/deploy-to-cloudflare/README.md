# `@dwk` discovery starter — one-click Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/davidwkeith/workers/tree/main/examples/deploy-to-cloudflare)

A minimal, self-contained Worker that composes two published `@dwk` packages —
[`@dwk/webfinger`](https://www.npmjs.com/package/@dwk/webfinger) (RFC 7033) and
[`@dwk/host-meta`](https://www.npmjs.com/package/@dwk/host-meta) (RFC 6415) —
into the discovery layer of a self-owned web presence.

Why these two: both are **stateless with zero Cloudflare bindings** (no D1, R2,
KV, Durable Objects, queues, or secrets), so the one-click deploy provisions
nothing, runs on the free plan, and works the moment it lands on your
`*.workers.dev` subdomain. The Worker answers for whatever hostname serves it:

- `/` — a landing page that explains itself
- `/.well-known/webfinger?resource=acct:me@<your-host>` — WebFinger JRD
- `/.well-known/host-meta` and `/.well-known/host-meta.json` — XRD ⇄ JRD

## Run locally

```sh
npm install
npm run dev
```

## Make it yours

1. Edit `USER` and the resource map in [`src/index.ts`](src/index.ts) — once you
   serve one fixed domain, construct the handlers once at module scope instead
   of per request.
2. Add a [route or custom domain](https://developers.cloudflare.com/workers/configuration/routing/)
   in `wrangler.jsonc` so discovery lives at your own domain (identity is rooted
   there).
3. Compose more `@dwk` packages into the same Worker — IndieAuth, Micropub,
   Webmention, an edge Solid Pod, ActivityPub — following the
   [composition model](../../README.md#composition-model). Each package's
   [spec](../../spec/packages/) lists the bindings its `Env` fragment declares;
   add their union to `wrangler.jsonc`.

## Note on isolation

This directory is deliberately **not** part of the pnpm workspace: its `@dwk`
dependencies come from npm (the published `0.1.0-beta.N` prereleases), so
Cloudflare's deploy button can build it in isolation — and so it exercises
exactly what a third-party consumer of the published packages gets.
