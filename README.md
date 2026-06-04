# `@dwk` — IndieWeb + Solid packages

> Composable npm packages that each implement an open web standard, run as
> [Cloudflare Workers](https://developers.cloudflare.com/workers/), and deploy
> onto an end user's **own** Cloudflare account.

`@dwk` is an npm scope under which standards-implementing packages live. This
repository contains the **IndieWeb + Solid cohort**: building blocks that give
anyone a self-owned, standards-compliant web presence — IndieWeb
publishing/interaction today, a [Solid](https://solidproject.org/) Pod data
vault next — running serverless on infrastructure the user controls.

There is **no hosted product and no central server.** A developer can
`npm install` any of these packages, compose them into a single Worker behind
one domain, and deploy to a user's account. [Anglesite](https://anglesite.app)
is the first consumer; every package must also stand alone for any third-party
developer.

## Why

Owning your internet presence across open protocols today means either trusting
a hosted service or babysitting a server. These packages remove that choice:
the data and keys live only on infrastructure the user owns, and the runtime is
serverless edge compute that scales to zero.

## Packages

| Package | Type | Responsibility |
|---|---|---|
| [`@dwk/indieauth`](spec/packages/indieauth.md) | endpoint | IndieAuth authorization + token + metadata endpoints; PKCE; profile-URL verification; scope issuance. |
| [`@dwk/micropub`](spec/packages/micropub.md) | endpoint | Micropub create/update/delete; JSON + form-encoded; media endpoint (R2); `q=config` / `q=source`. Consumes IndieAuth tokens. |
| [`@dwk/webmention`](spec/packages/webmention.md) | endpoint | Webmention receiver (async verification queue) + sender (on publish); inbox store. |
| [`@dwk/webfinger`](spec/packages/webfinger.md) | endpoint | WebFinger (RFC 7033) discovery at `/.well-known/webfinger`; `resource` dispatch, `rel` filtering, JRD output. Stateless; config-supplied resource map. |
| [`@dwk/solid-pod`](spec/packages/solid-pod.md) | endpoint + DO | Edge Solid Pod: LDP verbs, content negotiation, N3 Patch, WAC, notifications. Exports the per-pod **Durable Object** class. |
| [`@dwk/wac`](spec/packages/wac.md) | lib | Web Access Control evaluation (effective-ACL walk, Append vs Write). Used by `solid-pod`. |
| [`@dwk/dpop`](spec/packages/dpop.md) | lib | DPoP proof verification. Shared by `indieauth` token validation and `solid-pod` Resource Server. |
| [`@dwk/rdf`](spec/packages/rdf.md) | lib | Thin Turtle/JSON-LD parse + serialize over N3.js; triple ↔ store helpers. Edge-budget-conscious. |
| [`@dwk/log`](spec/packages/log.md) | lib | Injectable structured-logging seam (`Logger` + no-op/console loggers). Cross-standard reusable; protocol-agnostic. |
| [`@dwk/store`](spec/packages/store.md) | lib | DO-SQLite quad store + R2 copy-on-write blob bodies behind one storage-agnostic interface. |

**Mental model:** stateless Worker front door → per-pod Durable Object as the
consistency / authz / notification authority → R2 for blob bodies. `solid-pod`
is the only package that ships a Durable Object; the IndieWeb trio is stateless
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
- [Open questions](spec/open-questions.md) — deferred decisions.
- [`spec/packages/`](spec/packages/) — one detailed spec per package.

## License

[ISC](LICENSE) — permissive, OSI-approved, npm's default. Chosen to match the
maximally-permissive, democratization goal of the project.
