# `@dwk/webfinger`

> WebFinger (RFC 7033) account/resource discovery endpoint. Endpoint package.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/webfinger.md) for the full
requirements.

WebFinger maps a queried `resource` URI (`acct:`, `mailto:`, `https:`) to a
**JSON Resource Descriptor** (JRD) of links — profile page, avatar, OIDC issuer,
the `self` ActivityPub actor. It is the foundational discovery step for
federation: fediverse software resolves `acct:user@domain` against
`/.well-known/webfinger` before it can follow or address an account.

## Worker vs. static (why this package exists)

WebFinger is **borderline static**. A static site generator can emit a single
`/.well-known/webfinger` JRD, and for a **single-identity** site that often
suffices. Spec-correct behaviour, however, needs request logic a static host
cannot do:

- dispatch on the `resource` query parameter and return **404** for a resource
  this server does not control (a static file returns `200` for any `resource=`);
- echo the matched `subject`, which **must equal** the queried `resource` URI
  (fediverse software rejects a mismatch);
- filter the returned `links` by the `rel` query parameter(s).

So: ship the package for correct multi-resource / `rel`-filtered behaviour; the
degenerate single-resource, no-`rel` case may stay a static file.

## Usage

```ts
import { createWebfinger } from "@dwk/webfinger";

const webfinger = createWebfinger({
  resources: {
    "acct:alice@example.com": {
      aliases: ["https://example.com/users/alice"],
      links: [
        {
          rel: "http://webfinger.net/rel/profile-page",
          type: "text/html",
          href: "https://example.com/",
        },
        {
          rel: "self",
          type: "application/activity+json",
          href: "https://example.com/users/alice",
        },
      ],
    },
  },
});

// In your Worker's fetch handler, mount at the well-known path:
//   GET /.well-known/webfinger?resource=acct:alice@example.com
return webfinger(request, env, ctx);
```

- `resource` absent → **400**; `resource` not controlled → **404**; matched →
  **200** with `subject` (echoing the queried URI), `aliases`, and `links`.
- A `rel` parameter (repeatable) filters `links` to the matching relations;
  `aliases` and `properties` are unaffected.
- Every response — success or error — carries `Access-Control-Allow-Origin: *`
  per RFC 7033 §10.2, because discovery data is public. `OPTIONS` returns a CORS
  preflight; non-`GET`/`HEAD` methods get **405**.
- The response media type is `application/jrd+json`.

### Dynamic resolution

For a resource set that is large or derived from stored data, pass a `resolve`
function instead of (or alongside) the static `resources` map. The static map is
consulted first; the resolver is the fallback. Returning `undefined` yields a
`404`.

```ts
const webfinger = createWebfinger({
  resolve: async (resource, rels) => {
    const profile = await lookupProfile(resource); // your data source
    return profile ? { links: profile.toWebfingerLinks(rels) } : undefined;
  },
});
```

`createWebfinger` **fails loudly** at construction if neither `resources` nor
`resolve` is supplied — a WebFinger endpoint that controls no resources is always
a misconfiguration.

## Design

Pure and **stateless**: no Durable Object, no D1, and no required Cloudflare
bindings — the `resource → JRD` mapping is config-supplied (composition
contract), never read from the global environment. The discovery logic
unit-tests under Node without a Workers runtime.

## Observability

Discovery events are emitted through the injected `@dwk/log` `Logger`/`Metrics`
seams (default no-op): `webfinger.resolved` for a match, `webfinger.rejected`
for a `400`/`404`/`405`. A queried `resource` is reduced to its **host** in logs
— the local part of an `acct:` handle is never recorded.
