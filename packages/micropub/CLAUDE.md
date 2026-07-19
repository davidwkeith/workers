# @dwk/micropub

Micropub publishing protocol endpoint.

## What this is

Handles create/update/delete of posts via the Micropub protocol. Accepts both
form-encoded and JSON request bodies, parses Microformats 2 (mf2) objects,
and stores posts in D1. Includes an R2-backed media endpoint for file uploads.
Requires IndieAuth access tokens with scope-based authorization — `create`,
`update`, `delete`, `media` scopes. Supports `q=config` and `q=source` queries.
Also contributes a `@dwk/mcp` tool (`createMicropubMcpTools` →
`micropub_publish`) so an authorized agent can publish through the same
`publishPost` path the HTTP `create` action uses.

## Spec

`spec/packages/micropub.md` — authoritative requirements.

## Key constraints

- **DPoP mandatory on every request.** Bearer-token-only clients (e.g.,
  micropub.rocks default mode) cannot authenticate. Every authenticated request
  must present a valid DPoP proof bound to the access token.
- **Subject (`me`) binding.** The access token's `me` claim must match the
  configured profile URL. Tokens issued for a different identity are rejected.
- **JTI dedup in D1.** DPoP proof `jti` values are stored in D1 (`AUTH_DB`) and
  checked for replay on every request.
- **Media endpoint.** Uploads go to R2 (`MEDIA` bucket). The `media` scope is
  separate from `create` for least privilege.
- **Scope enforcement.** Each operation requires its specific scope; `create`
  does not grant `update` or `delete`.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- D1: `MICROPUB_DB`, `AUTH_DB`
- R2: `MEDIA`
- Bindings: `TOKEN_SIGNING_KEY` (test key)

```bash
pnpm test --project @dwk/micropub
```

## File layout

```
src/index.ts       # public surface: createMicropub, store, mf2 parsing, auth, mcp tools, types
src/config.ts      # MicropubConfig type and Env fragment
src/handler.ts     # createMicropub factory (create/update/delete/query/media routes); exports publishPost
src/mcp-tools.ts   # createMicropubMcpTools — the `micropub_publish` @dwk/mcp tool
src/store.ts       # createMicropubStore (D1-backed post persistence)
src/mf2.ts         # mf2 body parsing (form + JSON), update operations, source view
src/auth.ts        # token extraction, scope checking, DPoP enforcement
src/event.ts       # h-event post type: markup rendering, h-event → CalendarEvent
src/fediverse.ts   # h-entry → PostInput adapter + syndication to @dwk/activitypub's /publish (#278; wire-format contract, no AP import)
src/replay.ts      # D1-backed DPoP proof jti replay record (short TTL)
src/log.ts         # structured observability event taxonomy (@dwk/log vocabulary)
src/*.test.ts      # colocated tests
```

## Dependencies

- `@dwk/calendar` — CalendarEvent model the h-event adapter maps onto.
- `@dwk/dpop` — DPoP proof verification.
- `@dwk/indieauth` — access token verification and signing.
- `@dwk/log` — structured logging.
- `@dwk/mcp` — `ToolDefinition`/`ToolCallResult` types for `mcp-tools.ts`'s
  `micropub_publish` tool.
