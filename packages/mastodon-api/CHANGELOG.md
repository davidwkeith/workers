# @dwk/mastodon-api

## 0.1.0-beta.1

### Minor Changes

- 20c4e9e: Serve the owner's own posts on account profiles, and stop 404ing the profile
  companion endpoints real clients call — the fixes for the quirks surfaced by
  the 2026-07-23 Ice Cubes client-QA run (conformance/mastodon-client-qa.md,
  issue #327).

  - **`@dwk/mastodon-api`:** new `GET /api/v1/accounts/:id/statuses` route —
    the owner id answers their own posts (newest-first, standard `Link`
    pagination) via the new optional `MastodonBackend.ownStatuses` seam
    method; remote account ids answer a valid-but-empty page (no remote
    status history is stored). `GET /api/v1/accounts/relationships` joins the
    exact-route stub roster (previously the dynamic `accounts/:id` pattern
    misread `relationships` as an account id and 404ed), and the dynamic
    profile companions `accounts/:id/{followers,following,featured_tags}`
    answer valid-but-empty pages.
  - **`@dwk/activitypub`:** the DO's `__client/timeline` accepts `source=1`
    to restrict a page to owner outbox posts (skipping the inbox scan
    entirely), and `buildMastodonBackend` implements `ownStatuses` over it.

- dc59912: Implement `follow` notifications (the deferred phase-2 gap): `@dwk/activitypub`'s `#onFollow` now stores a _new_ follower's `Follow` (or FEP-1b12 `Group` membership `Join`) in the actor's inbox — a re-Follow from a still-recorded follower is not a fresh notification — and the `__client/notifications` classifier surfaces those rows; `@dwk/mastodon-api`'s `notificationEntity` maps them to Mastodon's `type: "follow"` (account attached, `status: null`), so clients like Tusky and Pixelfed now see new-follower notifications. Storing via the existing inbox path also queues the follower's actor-profile fetch, so the notification renders with a real display name and avatar once hydrated.
- 07fc404: Resolve two Mastodon read-surface fidelity gaps for locally-held targets. The actor DO gains `#resolveLocalObject` (pure SQL over its owner outbox then inbox, never an outbound fetch): a reply whose `inReplyTo` names a post the DO holds now carries that post's snowflake as `in_reply_to_id` plus its author as `in_reply_to_account_id` (the owner account when replying to the owner's own post), and a bare-IRI `Announce` of a locally-held post now hydrates its reblog with the real content and author instead of rendering content-less. Targets the DO does not hold still degrade to `null`/content-less as before — dereferencing a remote object is the remaining increment. New optional `BackendEntry.inReplyTo`/`BackendEntry.boost` fields carry the resolution through the adapter into `statusEntity`.
- 77d929a: Add an opt-in owner-scoped write surface to the Mastodon client API (`config.allowWrites`, default off). When enabled, `POST /api/v1/statuses` lets the single owner account author a status through a `write`-scoped bearer: the plain-text `status` is rendered to `Note` HTML (with `spoiler_text`/`sensitive` carried through), published via `@dwk/activitypub`'s existing outbox/fan-out path over a new internal `__client/publish` DO route, and returned as the owner-attributed `Status`. This deliberately widens the documented plain-bearer DPoP-everywhere exception from read-only to owner-scoped write — but only when opted in; the default keeps every write route `404`, so the exception stays strictly read-only. Enforcement: owner account required (`422` for app-level tokens), `write`/`write:statuses` scope required (`403` otherwise), 500-char ceiling. New seam `MastodonBackend.publishStatus?` and `tokenHasScope` helper. Delete, interaction verbs, follow, and reply-on-create are follow-up increments.

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/oauth@0.1.0-beta.5

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
