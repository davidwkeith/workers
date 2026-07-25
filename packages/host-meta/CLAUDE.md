# @dwk/host-meta

Web Host Metadata (RFC 6415) discovery endpoint.

## What this is

Serves `/.well-known/host-meta` in both XRD (XML) and JRD (JSON) formats with
content negotiation. Advertises the `lrdd` (Link-based Resource Descriptor
Discovery) template pointing to WebFinger. Largely superseded by WebFinger
itself, but still expected by some fediverse and legacy OpenID software.

## Spec

`spec/packages/host-meta.md` — authoritative requirements.

## Key constraints

- **Content negotiation.** Must serve both `application/xrd+xml` (default at
  the base path) and `application/json` (at `/host-meta.json` or via Accept
  header). The XRD serializer must properly escape XML entities.
- **No Cloudflare imports.** Pure handler, tests under Node.
- **Borderline static.** Single-identity sites could use Anglesite-generated
  static files instead; this package exists for multi-identity and dynamic cases.
