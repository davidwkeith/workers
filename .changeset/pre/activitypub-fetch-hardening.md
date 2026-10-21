---
"@dwk/activitypub": major
---

Send a descriptive `User-Agent` on every outbound fediverse request (key resolution, delivery, discovery): some peers — and the anti-scraper challenge layers (e.g. Anubis) a growing number of hosts run in front of federated software — treat an unidentified client as a bot and block it, which previously surfaced only as an opaque `key_unresolved` signature rejection. New `ActivityPubConfig.userAgent` (defaults to the new `DEFAULT_USER_AGENT` export) lets a deployment identify itself specifically, per the composition contract. The default key resolver now also logs the actual failure (`activitypub.key_resolution.failed`: `reason`, `host`, and `status` when available, at `warn` for operator-actionable failures and `debug` for the attacker-trivial-to-trigger ones) so an operator can tell a network/HTTP failure apart from a bot-challenge redirect loop without custom instrumentation — never the raw error message, which can embed full request URLs.

`deliverActivity`, `resolveHandleGuarded`, and `fetchActorGuarded` (all exported from the package root) each gain a new required `userAgent` parameter — for `deliverActivity`, inserted after `fetchImpl` and before the existing optional `now`/`timeoutMs`. Direct callers of these exports need updating.
