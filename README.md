# `@dwk` — IndieWeb + Solid packages

> Composable npm packages that each implement an open web standard, run as
> [Cloudflare Workers](https://developers.cloudflare.com/workers/), and deploy
> onto an end user's **own** Cloudflare account — or, for those who'd rather run
> their own box, self-host the same packages with the `@dwk/server` Docker image
> or `dwk-serve` bin (see [Running it](#running-it)).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/davidwkeith/workers/tree/main/examples/deploy-to-cloudflare)

`@dwk` is an npm scope under which standards-implementing packages live. This
repository contains the **IndieWeb + Solid cohort**: building blocks that give
anyone a self-owned, standards-compliant web presence — IndieWeb
publishing/interaction today, a [Solid](https://solidproject.org/) Pod data
vault next — running serverless on infrastructure the user controls.

There is **no hosted product and no central server.** A developer can
`npm install` any of these packages and compose them into a single Worker behind
one domain — then deploy to a user's **own** Cloudflare account, or self-host the
same packages on a box the user owns via the `@dwk/server` Docker image /
`dwk-serve` bin (see [Running it](#running-it)). Either way the data and keys
live only on infrastructure the user controls.
[Anglesite](https://anglesite.app) is the first consumer; every package must
also stand alone for any third-party developer.

## Why

Owning your internet presence across open protocols today means either trusting
a hosted service or babysitting a server. These packages remove that choice: the
data and keys live only on infrastructure the user owns — serverless edge compute
that scales to zero on Cloudflare, or a single self-hosted process on a box of
their own.

## Packages

| Package | Type | Responsibility |
|---|---|---|
| [`@dwk/indieauth`](spec/packages/indieauth.md) | endpoint | IndieAuth authorization + token + metadata endpoints; PKCE; profile-URL verification; scope issuance. |
| [`@dwk/micropub`](spec/packages/micropub.md) | endpoint | Micropub create/update/delete; JSON + form-encoded; media endpoint (R2); `q=config` / `q=source`. Consumes IndieAuth tokens. |
| [`@dwk/webmention`](spec/packages/webmention.md) | endpoint | Webmention receiver (async verification queue) + sender (on publish); inbox store. |
| [`@dwk/microsub`](spec/packages/microsub.md) | endpoint | Microsub server (read side): channel/feed subscriptions, server-side polling (Atom/RSS/JSON Feed/`h-feed`), and a normalised JF2 timeline via a Cron-triggered queue (D1). Consumes IndieAuth tokens. |
| [`@dwk/websub`](spec/packages/websub.md) | endpoint | WebSub (W3C) hub: D1 subscription store with lease expiry, intent-verification callbacks, HMAC-signed content distribution via queue. Publish-side complement to `webmention`. |
| [`@dwk/webfinger`](spec/packages/webfinger.md) | endpoint | WebFinger (RFC 7033) discovery at `/.well-known/webfinger`; `resource` dispatch, `rel` filtering, JRD output. Stateless; config-supplied resource map. |
| [`@dwk/host-meta`](spec/packages/host-meta.md) | endpoint | Web Host Metadata (RFC 6415) discovery at `/.well-known/host-meta`(`.json`); XRD ⇄ JRD content negotiation, `lrdd` template to WebFinger. Stateless; config-supplied links. |
| [`@dwk/vc`](spec/packages/vc.md) | endpoint | `did:web` identity + Verifiable Credential (VCDM 2.0) issuance/verification with JCS Data Integrity proofs; Bitstring Status List revocation (D1). DID document is static. |
| [`@dwk/solid-pod`](spec/packages/solid-pod.md) | endpoint + DO | Edge Solid Pod: LDP verbs, content negotiation, N3 Patch, WAC, notifications. Exports the per-pod **Durable Object** class. |
| [`@dwk/webauthn`](spec/packages/webauthn.md) | endpoint + DO | WebAuthn / passkeys relying party: registration + authentication ceremonies; attestation (`none`/`packed` self) + assertion verification on Web Crypto. Per-RP **Durable Object** for challenge state + credential records. Exploratory. |
| [`@dwk/activitypub`](spec/packages/activitypub.md) | endpoint + DO | ActivityPub server: per-actor inbox/outbox, signed (HTTP Signatures) server-to-server delivery with retry/backoff, Follow/Accept, owner publish fan-out. Per-actor **Durable Object**. |
| [`@dwk/remotestorage`](spec/packages/remotestorage.md) | endpoint + DO | remoteStorage: OAuth-scoped document/folder PUT/GET/DELETE with ETags and TOCTOU-free conditional writes, public reads, descendant-sensitive folder listings. Per-account **Durable Object**. |
| [`@dwk/atproto-pds`](spec/packages/atproto-pds.md) | endpoint + DO | AT Protocol Personal Data Server: MST/DAG-CBOR/CAR repository, `did:web` identity, P-256 commit signing, `com.atproto.*` XRPC. Per-account repository **Durable Object**. Exploratory; shares neither `@dwk/store` nor `@dwk/rdf`. |
| [`@dwk/webdav`](spec/packages/webdav.md) | endpoint | WebDAV (RFC 4918, Class 2) façade over a Solid pod, so the pod mounts as a network drive in OS file managers. Protocol core, Class 2 verb router with locking, `COPY`/`MOVE`, and scoped app-password auth are implemented against the live pod DO. **In progress** — the hosted litmus conformance run is the remaining increment. |
| [`@dwk/mastodon-api`](spec/packages/mastodon-api.md) | endpoint | Mastodon-compatible client API subset, so off-the-shelf fediverse apps log in and browse the owner's account: app registration + OAuth, instance documents, timelines/notifications/markers over an injected `MastodonBackend` seam. Reads `@dwk/activitypub`'s DO only through that seam. |
| [`@dwk/solid-oidc`](spec/packages/solid-oidc.md) | endpoint | Solid-OIDC provider composed from `@dwk/oauth`'s primitives: authorization-code + PKCE (S256) + DPoP, issuing ES256-signed WebID access tokens a `@dwk/solid-pod` accepts. |
| [`@dwk/wac`](spec/packages/wac.md) | lib | Web Access Control evaluation (effective-ACL walk, Append vs Write). Used by `solid-pod`. |
| [`@dwk/dpop`](spec/packages/dpop.md) | lib | DPoP proof verification. Shared by `indieauth` token validation and `solid-pod` Resource Server. |
| [`@dwk/http-signatures`](spec/packages/http-signatures.md) | lib | HTTP Message Signatures (RFC 9421) + legacy `draft-cavage` sign/verify. Cross-standard reusable; consumed by `activitypub` for server-to-server delivery. |
| [`@dwk/oauth`](spec/packages/oauth.md) | lib | OAuth 2.0 server building blocks: RFC 8414 metadata, RFC 7662 introspection, RFC 7009 revocation, RFC 9126 PAR, RFC 7591 dynamic client registration. Cross-standard reusable; shared by `indieauth` and the eventual Solid-OIDC OP. |
| [`@dwk/rdf`](spec/packages/rdf.md) | lib | Thin Turtle/JSON-LD parse + serialize over N3.js; triple ↔ store helpers. Edge-budget-conscious. |
| [`@dwk/log`](spec/packages/log.md) | lib | Injectable structured-logging seam (`Logger` + no-op/console loggers). Cross-standard reusable; protocol-agnostic. |
| [`@dwk/store`](spec/packages/store.md) | lib | DO-SQLite quad store + R2 copy-on-write blob bodies behind one storage-agnostic interface. |
| [`@dwk/ldn`](spec/packages/ldn.md) | lib | Linked Data Notifications primitives (inbox discovery, notification validation, listing). RDF-only; shared by `solid-pod` and `activitypub`. Discovery reachable n3-free as `@dwk/ldn/discovery`. |
| [`@dwk/calendar`](spec/packages/calendar.md) | lib | Canonical JSCalendar (RFC 8984)-shaped event model + RFC 5545 iCalendar / JSCalendar serializers. Protocol-agnostic; per-standard adapters live in the endpoint packages. |
| [`@dwk/mf2`](spec/packages/mf2.md) | lib | Microformats2 `h-entry` → JF2 extraction + allowlist HTML sanitizer, on the runtime's `HTMLRewriter`. Shared by `microsub` (h-feed timelines) and `webmention` (mention enrichment). |
| [`@dwk/mcp`](spec/packages/mcp.md) | lib | Model Context Protocol server core: dependency-free JSON-RPC 2.0 + Streamable HTTP, tools-only v1 subset, per-tool scope-intersection authz, and a bearer + DPoP auth bridge. Cross-standard reusable. Tool contributions ship from `micropub`, `microsub`, `webmention`, `solid-pod`, and `activitypub`. |
| [`@dwk/esi`](spec/packages/esi.md) | lib | Streaming Edge Side Includes processor: resolves `<esi:include>`/`<esi:comment>`/`<esi:remove>` in a composed Worker's outgoing `Response`, fetching fragments concurrently through `@dwk/safe-fetch`. Cross-standard reusable. |
| [`@dwk/safe-fetch`](spec/packages/safe-fetch.md) | lib | SSRF-safe outbound fetch + capped-body reads, shared by every package that fetches an attacker- or user-supplied URL. Cross-standard reusable. |
| [`@dwk/cf-shims`](spec/packages/cf-shims.md) | lib | Node-backed implementations of the Cloudflare Workers binding interfaces (D1/R2/KV/Queue/cron/Durable Objects) and runtime-global seams. Extracted from `@dwk/server`, which is its first consumer, not its owner. |
| [`@dwk/deno-host`](spec/packages/deno-host.md) | lib | Cloudflare-interface emulation for the (gated, exploratory) Deno Deploy host: libSQL/Turso behind `D1Database`/`SqlStorage`, a KV-lease Durable Object emulation, and a KV-backed Queue. Runtime-agnostic — no `node:` imports. |

**Mental model:** stateless Worker front door → per-pod Durable Object as the
consistency / authz / notification authority → R2 for blob bodies. The packages
that ship a **Durable Object** are `solid-pod` (per-pod), `activitypub`
(per-actor), `remotestorage` (per-account), `webauthn` (per-RP), `atproto-pds`
(per-account repository), and `store` (the DO-SQLite storage object the others
build on); the IndieWeb trio (`indieauth`, `micropub`, `webmention`) is stateless
handlers backed by D1 / R2.

## Composition model

Each endpoint package exports a factory that returns a `fetch`-compatible
handler, mountable under a path prefix so several packages route inside one
Worker:

```ts
import { createIndieAuth } from "@dwk/indieauth";
import { createMicropub } from "@dwk/micropub";
import { createWebmention } from "@dwk/webmention";

const indieauth = createIndieAuth({ baseUrl: "https://example.com" });
const micropub = createMicropub({ baseUrl: "https://example.com", mediaBucket: "MEDIA" });
const webmention = createWebmention({ baseUrl: "https://example.com" });

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/auth"))       return indieauth(request, env, ctx);
    if (pathname.startsWith("/micropub"))   return micropub(request, env, ctx);
    if (pathname.startsWith("/webmention")) return webmention(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
};
```

Each package declares the Cloudflare bindings it requires as a TypeScript `Env`
interface fragment; the composed `Env` is the union, satisfied in
`wrangler.toml`. See the [composition contract](spec/composition-contract.md)
for the full rules.

> Identity is rooted at the user's domain: the same domain serves the IndieWeb
> identity (IndieAuth) and the WebID the Pod authenticates against.

## Running it

**Cloudflare first.** Cloudflare Workers is the primary, recommended deployment
target. Two secondary paths run the **same protocol logic byte-for-byte**
elsewhere: self-hosting the `@dwk/server` Docker image on your own box or any
other cloud, or — exploratory, with real gaps — Deno Deploy. Pick one:

### On Cloudflare (primary)

**One-click.** The fastest path is the deploy button, which clones this repo
into your own GitHub/GitLab account and deploys the
[discovery starter](examples/deploy-to-cloudflare/) — `@dwk/webfinger` +
`@dwk/host-meta` composed into one Worker — onto your own Cloudflare account:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/davidwkeith/workers/tree/main/examples/deploy-to-cloudflare)

Those two packages are stateless with **zero bindings**, so nothing is
provisioned and the Worker answers on your `*.workers.dev` subdomain
immediately, on the free plan. From there, grow it by composing more packages
into the same Worker (below).

**By hand.** `npm install` the packages you want, compose them into one Worker (the
[composition above](#composition-model)), declare the union of each package's
`Env` bindings in `wrangler.toml`, and deploy to your own account:

```sh
npm i @dwk/indieauth @dwk/micropub @dwk/webmention
# wrangler.toml: a route for your domain + the bindings the packages declare —
# D1 databases, R2 buckets, KV namespaces, secrets, and (for @dwk/solid-pod /
# @dwk/webauthn) a [[durable_objects.bindings]] entry + migration.
npx wrangler deploy
```

Each package's [spec](spec/packages/) lists the exact bindings it needs; a
missing binding fails loudly at startup.

**Tor / Onion Routing (optional).** Cloudflare's
[Onion Routing](https://developers.cloudflare.com/network/onion-routing/) lets
Tor Browser users reach your zone over Tor without exiting through a
(potentially hostile) exit node. It is a zone-level toggle, free on every plan,
and fully transparent to the Worker — the Host header and SNI are preserved, so
every identity URL (IndieAuth issuer, ActivityPub actor, WebFinger subject)
stays your canonical `https://` origin. Enable it under **Network → Onion
Routing** in the dashboard, or via the API:

```sh
curl -X PATCH \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/opportunistic_onion" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"value":"on"}'
```

The reverse direction is out of scope: Workers cannot make outbound fetches to
`.onion` hosts (RFC 7686 keeps them out of public DNS), so `@dwk/safe-fetch`
rejects `.onion` URLs up front as `blocked_host` — a `.onion` Webmention
source, WebSub callback, or ActivityPub inbox is dropped cleanly rather than
failing as an opaque network error.

### Self-hosted (Node: Docker or the `dwk-serve` bin) — VPS, homelab, or NAS

[`@dwk/server`](packages/server/README.md) runs every package on a single
Node.js/[Express](https://expressjs.com/) process that serves the endpoints
**and** static files from one domain, emulating the Cloudflare primitives
(Durable Objects, R2, D1, KV, queues/cron, WebSockets) on **SQLite + the local
filesystem** — no extra services. That means no cloud account is required at
all: a home server, NAS, Raspberry Pi, or any other box under your desk works
exactly the same as a VPS, as long as it's a single long-lived process with a
persistent disk. Write a composition-root config module (the "Worker entry +
`wrangler.toml`" you'd otherwise hand-write; see
[`examples/`](packages/server/examples/)), then either:

```sh
# Docker (the recommended self-host path):
docker build -f packages/server/Dockerfile -t dwk-server .
docker run -p 3000:3000 -v dwk-data:/data \
  -e DWK_BASE_URL=https://pod.example dwk-server

# …or the bin, to run on the host directly:
npm i @dwk/server
dwk-serve ./composition.mjs --port 3000
```

Put a TLS-terminating reverse proxy (Caddy / nginx / Traefik) in front —
identity is HTTPS-rooted. The data directory holds keys and all pod data; mount
it as a private volume (`0700`) and back it up. See the
[`@dwk/server` README](packages/server/README.md) for the config format,
security posture, and Cloudflare ⇄ self-host data portability. Design notes:
[`spec/self-hosting.md`](spec/self-hosting.md).

This single-process mode is the recommended default for a single-owner
deployment. If you outgrow it — real horizontal scale or HA across a fleet of
replicas — there's an **experimental, opt-in central mode**
([`spec/scale-out.md`](spec/scale-out.md), `packages/server/docker-compose.yml`
+ `k8s-notes.md`) trading single-request latency for throughput/availability;
see the [`@dwk/server` README](packages/server/README.md#central-mode-horizontal-scale-out-experimental)
for when it's (and isn't) worth reaching for, and `dwk-migrate` for moving
between the two modes.

**On AWS, GCP, or any other cloud.** There is no AWS- or GCP-native `@dwk`
host, and none is planned — the same Docker image above **is** the supported
answer everywhere else, because it needs only a long-lived process with a
persistent, single-writer filesystem:

- **AWS**: ECS/Fargate with an attached EFS/EBS volume, or plain EC2 running
  `docker run` directly. (Lambda / Lambda@Edge do **not** work — no
  persistent disk, and not even fetch-shaped.)
- **GCP**: a GCE VM with a persistent disk, or a single always-on Cloud Run
  service pinned to exactly one instance (`minInstances`/`maxInstances = 1`)
  so autoscaling never breaks the single-writer invariant.
- **Top indie hosts**: Fly.io, DigitalOcean, Hetzner, Linode, a homelab box,
  bare metal — same `docker run` + volume + reverse-proxy shape as the
  quickstart above, no code changes.

See [`@dwk/server`'s "Deploying to AWS, GCP, or any other
cloud"](packages/server/README.md#deploying-to-aws-gcp-or-any-other-cloud)
for the full per-provider notes.

### Deno Deploy (exploratory — not yet a supported host)

[`@dwk/deno-host`](spec/packages/deno-host.md) is building-block Cloudflare-
interface emulation for Deno Deploy — the most credible *native* (non-
container) target beyond Cloudflare, but **not yet usable to compose any
`@dwk` package**. It now implements the D1/DO-SQLite shim over an external
libSQL/Turso database, single-writer actor + alarm emulation over a Deno KV
lease, and a durable at-least-once **queue** on Deno KV. One gap remains
unimplemented and demand-gated: an **object-storage** (`R2Bucket`-equivalent)
adapter — without it, no endpoint package can mount even at the lowest
conformance tier. It also depends on an external libSQL/Turso service, a
trade-off against this project's "data and keys live only on infrastructure
the user owns" thesis that isn't resolved yet. Track progress in
[`spec/deno-deploy-design.md`](spec/deno-deploy-design.md) and
[`spec/packages/deno-host.md`](spec/packages/deno-host.md).

Fastly Compute, AWS Lambda@Edge, and Puter were also investigated and are
explicit **non-goals** for now — each lacks a strongly-consistent store
and/or actor primitive the stateful packages require. See
[`spec/portability.md`](spec/portability.md) for the full per-provider
feasibility writeup and re-evaluation triggers.

## Status

**Implemented, unreleased.** The authoritative requirements live in
[issue #1](https://github.com/davidwkeith/workers/issues/1) and are decomposed
into technical specifications under [`spec/`](spec/). Every package now carries
real logic with colocated tests — there are no remaining `501 Not Implemented`
stubs — but all packages still sit at version `0.0.0`: nothing has been
published. Per-standard conformance (micropub.rocks, webmention.rocks, Solid)
is tracked in [`conformance/status.json`](conformance/status.json) and gates any
stable (`>=1.0.0`) release; those hosted suites are still `pending`.

## Documentation

The [`spec/`](spec/) directory holds the technical requirements:

- [Overview](spec/overview.md) — purpose, goals / non-goals, audience.
- [Architecture](spec/architecture.md) — package layout, mental model, naming.
- [Composition contract](spec/composition-contract.md) — handler shape,
  bindings, config conventions.
- [Non-functional requirements](spec/non-functional-requirements.md) —
  consistency, runtime budget, security, distribution.
- [Conformance & testing](spec/conformance-and-testing.md) — the test bars.
- [Self-hosting](spec/self-hosting.md) — the Cloudflare-first stance and the
  Node/Express + Docker self-host host ([`@dwk/server`](packages/server/README.md)).
- [Portability](spec/portability.md) — the multi-provider feasibility
  investigation (Docker/AWS/GCP viable now, Deno Deploy exploratory, Fastly
  Compute/Lambda@Edge/Puter non-goals) behind the [Running it](#running-it)
  section above.
- [Open questions](spec/open-questions.md) — deferred decisions.
- [`spec/packages/`](spec/packages/) — one detailed spec per package.

## License

[ISC](LICENSE) — permissive, OSI-approved, npm's default. Chosen to match the
maximally-permissive, democratization goal of the project.
