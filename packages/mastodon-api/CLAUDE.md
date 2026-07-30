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

- **Read-only by default; opt-in owner-scoped write surface.** With
  `config.allowWrites` absent/`false`, every write route answers `404` and
  the bearer-token exception stays strictly read-only. When enabled, a
  `write`-scoped, owner-bound bearer may post statuses
  (`POST /api/v1/statuses`) and manage pending follow requests
  (`POST /api/v1/follow_requests/:id/authorize`/`reject`). See
  `spec/packages/mastodon-api.md` § Write surface.
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
