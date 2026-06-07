# `@dwk/host-meta`

> Web Host Metadata (RFC 6415) host-meta discovery endpoint. Endpoint package.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/host-meta.md) for the full
requirements.

host-meta serves a host-wide resource-discovery document at
`/.well-known/host-meta` (XRD) and `/.well-known/host-meta.json` (JRD): a set of
top-level **`Link`** relations — at minimum an **`lrdd`** template pointing at
the site's WebFinger endpoint. It is largely **superseded by**
[`@dwk/webfinger`](../webfinger) for account discovery, but some fediverse and
OpenID software still fetch host-meta to find the `lrdd` template before falling
back to WebFinger.

## Worker vs. static (why this package exists)

host-meta is **borderline static**. A single-identity site can have its static
site generator emit fixed `host-meta` + `host-meta.json` files and skip this
package entirely. A Worker is justified only by:

- **Content negotiation** between the XRD (`application/xrd+xml`) and JRD
  (`application/jrd+json`) representations from the one `/.well-known/host-meta`
  URL (RFC 6415 §3), plus a `?format=` override; and
- a **dynamic `lrdd` template** pointing at this Worker's WebFinger endpoint.

If neither is needed, prefer the static output and do not mount this package.

## Usage

```ts
import { createHostMeta } from "@dwk/host-meta";

const hostMeta = createHostMeta({
  // Seeds an `lrdd` link templated to ...?resource={uri}
  webfingerUrl: "https://example.com/.well-known/webfinger",
  // Any additional static top-level links
  links: [
    {
      rel: "author",
      type: "text/html",
      href: "https://example.com/about",
    },
  ],
});

// In your Worker's fetch handler, mount at both well-known paths:
//   GET /.well-known/host-meta        → XRD by default
//   GET /.well-known/host-meta.json   → JRD
return hostMeta(request, env, ctx);
```

- The document is **request-invariant** — it is built once at construction from
  config and served verbatim. `createHostMeta` **fails loudly** if neither
  `webfingerUrl` nor any `links` is supplied; a host-meta that advertises
  nothing is always a misconfiguration.
- The two representations are **information-equivalent** (RFC 6415 §3): the XRD
  and JRD render the same `subject`, `properties`, and `links`.

### Content negotiation

The representation is chosen, in priority order:

1. an explicit `?format=json` / `?format=xml` query override;
2. the request path — `/.well-known/host-meta.json` always returns JRD
   (RFC 7033 §10.1);
3. the `Accept` header — JRD only when `application/jrd+json` is *strictly*
   preferred over `application/xrd+xml`; otherwise **XRD is the default** (for
   ties, wildcards, and a missing header).

Every response — success or error — carries `Access-Control-Allow-Origin: *`
(discovery data is public) and `Vary: Accept`. `OPTIONS` returns a CORS
preflight; non-`GET`/`HEAD` methods get **405**.

## Design

Pure and **stateless**: no Durable Object, no D1, and no required Cloudflare
bindings — the document is config-supplied (composition contract), never read
from the global environment. The serializers unit-test under Node without a
Workers runtime. The JRD link shaping is reused from
[`@dwk/webfinger`](../webfinger); the XRD serializer is the only surface new to
this package.

## Observability

Discovery events are emitted through the injected `@dwk/log` `Logger`/`Metrics`
seams (default no-op): `host-meta.served` with the negotiated `format`,
`host-meta.rejected` for a `405`. The document is host-wide, so no request
carries user data to redact.
