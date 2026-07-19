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

## Test environment

Node (`environment: "node"`). No Miniflare.

```bash
pnpm test --project @dwk/webfinger
```

## File layout

```
src/index.ts       # public surface: createWebfinger factory, JRD builder, resource normalization
src/config.ts      # config types and resolution
src/handler.ts     # createWebfinger factory
src/jrd.ts         # JRD building and rel filtering
src/lookup.ts      # client half: handle parsing, remote JRD lookup, actor-link selection (#277)
src/resource.ts    # resource URI normalization for case-insensitive matching
src/log.ts         # structured observability event taxonomy (@dwk/log vocabulary)
src/*.test.ts      # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.

## Depended on by

`@dwk/host-meta`, `@dwk/remotestorage`, `@dwk/activitypub` (the `lookup.ts`
client half, for community/handle discovery — injected fetch, no network of
its own)
