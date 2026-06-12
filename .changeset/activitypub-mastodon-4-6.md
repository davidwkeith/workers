---
"@dwk/activitypub": minor
---

Mastodon 4.6 federation updates. The actor document now carries the FEP-2c59
`webfinger` back-link — its canonical `acct:<username>@<domain>` handle, the
domain defaulting to the actor-URL host and overridable via the new `acctDomain`
config — so a peer can validate the handle ↔ actor mapping without a reverse
lookup. When the owner sets them, the actor also federates the Mastodon 4.6
profile-preference flags `showFeatured` / `showMedia` / `showRepliesInMedia`
(toot namespace) via new `ActorProfile` fields; unset flags are omitted. On the
inbox, a temporary signature-verification failure (the signer's key could not be
resolved, e.g. their server was briefly unreachable) now answers `503` +
`Retry-After` so the peer redelivers, rather than `401` which permanently drops
the activity; cryptographic/format failures still return `401`.
