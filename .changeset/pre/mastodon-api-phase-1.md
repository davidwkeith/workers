---
"@dwk/mastodon-api": minor
---

Add `@dwk/mastodon-api` — phase 1 of the Mastodon-compatible client API
(spec/mastodon-client-api.md, #348): app registration (`POST /api/v1/apps`),
Mastodon-shaped OAuth (`/oauth/authorize`, `/oauth/token` with
`authorization_code` + `client_credentials`, `/oauth/revoke`), instance
documents (v1 + v2), `verify_credentials` (apps + accounts), marker
persistence, and the valid-but-empty stub roster. Opaque SHA-256-hashed
bearer tokens in D1 (`AUTH_DB`) are the documented exception to the
DPoP-everywhere rule: read-only surface, isolated audience, revocable.
