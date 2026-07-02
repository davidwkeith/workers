# @dwk/remotestorage

remoteStorage server — endpoint + Durable Object.

## What this is

Per-account Durable Object implementing the remoteStorage protocol
(draft-dejong). A simpler, document-oriented personal data store that
demonstrates the same `@dwk/store` backing (DO SQLite + R2) can serve both Solid
(RDF) and remoteStorage (opaque documents). Handles document GET/PUT/DELETE with
OAuth 2.0 bearer tokens (not DPoP), per-module scope enforcement, public
`/public/` tree, and folder listings with descendant-sensitive ETags.

## Spec

`spec/packages/remotestorage.md` — authoritative requirements.

## Key constraints

- **Bearer tokens, not DPoP.** Unlike the rest of the stack, remoteStorage uses
  plain OAuth 2.0 bearer tokens. This is per-spec, not an oversight.
- **Per-module scopes.** Access is scoped to modules (path prefixes) with
  read-only (`module:r`) or read-write (`module:rw`) grants. The `ROOT_MODULE`
  grants access to the entire tree.
- **Public documents.** Documents under `/public/` are readable without
  authentication. This is a protocol requirement.
- **Folder listings.** GET on a folder path (trailing `/`) returns a JSON
  document listing children with their ETags and content types. Folder ETags
  change when any descendant changes.
- **CORS permissive.** remoteStorage requires permissive CORS headers on all
  responses (including preflight) for cross-origin client apps.
- **WebFinger discovery.** Clients discover the storage root via WebFinger
  (`rel="http://tools.ietf.org/id/draft-dejong-remotestorage"`). The
  `remoteStorageLink` helper generates the appropriate JRD link.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- DO: `RemoteStorageObject` (useSQLite)
- R2: `BLOBS`
- D1: `GC_DB`

```bash
pnpm test --project @dwk/remotestorage
```

## File layout

```
src/index.ts        # public surface: createRemoteStorage, GC handler, DO, auth, scopes, folder, CORS
src/config.ts       # RemoteStorageConfig type, Env fragment, path parsing
src/handler.ts      # createRemoteStorage factory (GET/PUT/DELETE routes)
src/storage.ts      # RemoteStorageObject Durable Object
src/auth.ts         # bearer token extraction and validation
src/jwt.ts          # JWT decode + JWKS signature verification (asymmetric only)
src/scope.ts        # scope parsing, authorization, module/path matching
src/folder.ts       # folder listing model and rendering
src/cors.ts         # CORS headers and preflight handler
src/discovery.ts    # remoteStorageLink for WebFinger integration
src/encoding.ts     # base64url/UTF-8 helpers for the token decode path
src/gc.ts           # createRemoteStorageGc (orphan R2 blob cleanup)
src/log.ts          # structured logging/metrics event vocabulary
src/test-harness.ts # test-only DO class (not published)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
- `@dwk/store` — DO SQLite + R2 storage layer.
- `@dwk/webfinger` — WebFinger link helpers for discovery.
