---
"@dwk/mastodon-api": minor
"@dwk/activitypub": minor
---

Add an opt-in owner-scoped write surface to the Mastodon client API (`config.allowWrites`, default off). When enabled, `POST /api/v1/statuses` lets the single owner account author a status through a `write`-scoped bearer: the plain-text `status` is rendered to `Note` HTML (with `spoiler_text`/`sensitive` carried through), published via `@dwk/activitypub`'s existing outbox/fan-out path over a new internal `__client/publish` DO route, and returned as the owner-attributed `Status`. This deliberately widens the documented plain-bearer DPoP-everywhere exception from read-only to owner-scoped write — but only when opted in; the default keeps every write route `404`, so the exception stays strictly read-only. Enforcement: owner account required (`422` for app-level tokens), `write`/`write:statuses` scope required (`403` otherwise), 500-char ceiling. New seam `MastodonBackend.publishStatus?` and `tokenHasScope` helper. Delete, interaction verbs, follow, and reply-on-create are follow-up increments.
