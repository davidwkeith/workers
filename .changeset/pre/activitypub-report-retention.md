---
"@dwk/activitypub": minor
---

Hard-delete a resolved (`Ignore`d) inbound `Flag` report after a
configurable retention window (`reportRetentionDays`, default 30) instead
of keeping it forever — `Ignore` previously only tombstoned the report
(`resolved_at`), so a hostile peer's dismissed reports could accumulate in
DO SQLite storage indefinitely. The delete runs off the alarm, on the same
schedule as delivery retries, pending accepts, relay verification, and
actor-profile hydration (#502).
