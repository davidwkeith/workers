# @dwk/webfinger

WebFinger (RFC 7033) discovery endpoint.

## What this is

Serves `/.well-known/webfinger` — maps resource URIs (acct:, https:) to JRD
(JSON Resource Descriptor) documents with typed links. Config-supplied resource
resolver maps resources to link sets. Supports `rel` filtering, proper 400/404
responses, and CORS headers. Foundational for fediverse federation and account
discovery.

## Spec

`spec/packages/webfinger.md` — authoritative requirements.

## Key constraints

- **Stateless.** No database access — resource mapping is injected via config.
  Single-identity sites may use static files instead; this package handles
  multi-resource and dynamic cases.
- **No Cloudflare imports.** Tests under Node even though endpoint packages
  typically use workerd — WebFinger is pure enough to stay in Node.
- **CORS required.** WebFinger responses must include appropriate CORS headers
  for cross-origin discovery.
- **`rel` filtering.** When `?rel=` params are present, only matching links
  appear in the response; the full resource record is not filtered away.
