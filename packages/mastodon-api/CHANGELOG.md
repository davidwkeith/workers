# @dwk/mastodon-api

## 0.1.0-beta.0

### Minor Changes

- 7b4349c: Add `@dwk/mastodon-api` — phase 1 of the Mastodon-compatible client API
  (spec/mastodon-client-api.md, #348): app registration (`POST /api/v1/apps`),
  Mastodon-shaped OAuth (`/oauth/authorize`, `/oauth/token` with
  `authorization_code` + `client_credentials`, `/oauth/revoke`), instance
  documents (v1 + v2), `verify_credentials` (apps + accounts), marker
  persistence, and the valid-but-empty stub roster. Opaque SHA-256-hashed
  bearer tokens in D1 (`AUTH_DB`) are the documented exception to the
  DPoP-everywhere rule: read-only surface, isolated audience, revocable.
- 90f1bc6: Phase 2 of the Mastodon-compatible client API (#349): the DO-backed read
  surface. `@dwk/activitypub` gains additive internal routes
  (`__client/timeline`, `__client/notifications`, `__client/entry`, extended
  `__stats`) and one new export, `createActivitypubMastodonApi`, composing
  `@dwk/mastodon-api`'s router over them (mirrors the `createSolidPodWebdav`
  precedent). `@dwk/mastodon-api` gains `GET /api/v1/timelines/home`, `GET
/api/v1/notifications`, `GET /api/v1/statuses/:id`, `GET
/api/v1/accounts/:id`, Mastodon-shaped snowflake IDs, RFC 8288 `Link`
  pagination, an allowlist HTML sanitizer for inbound status content, and the
  AS2 → Mastodon entity mapping (including FEP-1b12 reblog provenance for
  group-relayed posts). Remote account ids are a reversible encoding of the
  actor IRI, so `accounts/:id` resolves them with no backend call and no
  outbound fetch. Follow notifications are deferred to phase 3 (#350) —
  inbound `Follow` activities aren't currently stored in a form this read
  surface can classify; see the phase-2 implementation notes for why.
- 1c179ac: Hydrate remote Mastodon client accounts from an alarm-driven ActivityPub actor
  cache, include the owner's outbox posts in the home timeline, and expose
  stored reply, favourite, and reblog counts on statuses. Outbox timeline IDs
  use the snowflake source bit, preserving existing inbox IDs and marker
  positions.

### Patch Changes

- Updated dependencies [7b4349c]
- Updated dependencies [3e505be]
- Updated dependencies [bde0341]
- Updated dependencies [36a3be1]
  - @dwk/oauth@0.1.0-beta.4
