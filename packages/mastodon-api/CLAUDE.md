# @dwk/mastodon-api

Mastodon-compatible client API subset (read-only browsing via real clients).

## What this is

Endpoint package implementing enough of the Mastodon client API for
off-the-shelf fediverse apps (Pixelfed's app, Tusky, Elk) to log in and browse
this deployment's single owner account: app registration, the Mastodon app
OAuth flow, instance documents, `verify_credentials`, markers, and a
data-driven stub roster. Phase 2 (#349) adds timelines/notifications through
the `MastodonBackend` seam, implemented by `@dwk/activitypub`'s
`createActivitypubMastodonApi` adapter.

## Spec

`spec/packages/mastodon-api.md` — authoritative requirements. Design doc:
`spec/mastodon-client-api.md` (#327).

## Key constraints

- **Read-only surface.** No write endpoint ships behind these tokens;
  publishing stays with micropub/MCP. This keeps the bearer-token exception
  defensible.
- **Opaque hashed bearer tokens.** 256-bit random, SHA-256-hashed at rest in
  D1, plain `Bearer` — the repo's documented exception to DPoP-everywhere.
  These tokens are accepted only by this package's routes; every DPoP-bound
  surface rejects them structurally.
- **Scopes echoed, never narrowed.** Real clients treat a narrowed grant as an
  error; enforcement is that write endpoints simply don't exist (404).
- **D1 for auth state** (`AUTH_DB`, shared binding name, `mastodon_`-prefixed
  tables) — never KV. Codes are single-use via conditional UPDATE.
- **No login UI.** Owner authentication/consent is the config-injected
  `approveAuthorization` hook (the IndieAuth pattern).
- **Mastodon error shape** (`{"error": "..."}`) everywhere under `/api/`.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config: D1 `AUTH_DB`.

```bash
pnpm test --project @dwk/mastodon-api
```

## File layout

```
src/index.ts         # public surface: createMastodonApi, config + seam types
src/config.ts        # MastodonApiConfig, Env fragment, approval hook types
src/backend.ts       # MastodonBackend seam (implemented by @dwk/activitypub, phase 2)
src/handler.ts       # createMastodonApi router (CORS, 404 fallback, route table)
src/store.ts         # createMastodonStore (D1: apps, codes, tokens, markers)
src/entities.ts      # Mastodon entity serializers (pure)
src/apps.ts          # POST /api/v1/apps + apps/verify_credentials
src/oauth-flow.ts    # /oauth/authorize + /oauth/token + /oauth/revoke
src/auth.ts          # bearer + client authentication
src/accounts.ts      # accounts/verify_credentials, GET /api/v1/accounts/:id (handleGetAccount)
src/instance.ts      # instance v1 + v2
src/markers.ts       # GET/POST /api/v1/markers
src/stubs.ts         # data-driven valid-but-empty stub roster
src/encoding.ts      # random tokens, SHA-256, PKCE S256
src/errors.ts        # Mastodon error responses
src/snowflake.ts     # Mastodon-shaped snowflake ID codec
src/sanitize.ts      # allowlist HTML sanitizer for inbound status content
src/pagination.ts    # RFC 8288 Link header builder
src/timelines.ts     # GET /api/v1/timelines/home
src/notifications.ts # GET /api/v1/notifications
src/statuses.ts      # GET /api/v1/statuses/:id
src/*.test.ts        # colocated tests
```

## Dependencies

- `@dwk/oauth` — client metadata validation, RFC 7009 revocation handler,
  `ClientRecord`/`ClientStore` seam.

## Depended on by

`@dwk/activitypub` (phase 2's `createActivitypubMastodonApi` adapter).
