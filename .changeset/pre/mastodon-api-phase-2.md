---
"@dwk/mastodon-api": minor
"@dwk/activitypub": minor
---

Phase 2 of the Mastodon-compatible client API (#349): the DO-backed read
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
