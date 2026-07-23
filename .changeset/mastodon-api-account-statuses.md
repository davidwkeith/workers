---
"@dwk/mastodon-api": minor
"@dwk/activitypub": minor
---

Serve the owner's own posts on account profiles, and stop 404ing the profile
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
