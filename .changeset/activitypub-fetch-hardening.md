---
"@dwk/activitypub": minor
---

Send a descriptive `User-Agent` on every outbound fediverse request (key resolution, delivery, discovery): some peers — and the anti-scraper challenge layers (e.g. Anubis) a growing number of hosts run in front of federated software — treat an unidentified client as a bot and block it, which previously surfaced only as an opaque `key_unresolved` signature rejection. The default key resolver now also logs the actual failure (`activitypub.key_resolution.failed`: `reason`, `host`, and `status` when available) so an operator can tell a network/HTTP failure apart from a bot-challenge redirect loop without custom instrumentation.
