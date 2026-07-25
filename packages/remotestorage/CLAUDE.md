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
