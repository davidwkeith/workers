---
"@dwk/activitypub": minor
"@dwk/mastodon-api": minor
---

Show inbound quote posts in the Mastodon client API. A `Note` that quotes another post (FEP-044f `quote`, Pleroma `quoteUrl`, Fedibird `quoteUri`, Misskey `_misskey_quote`, or a FEP-e232 object link) has the quoted post hydrated from a locally-held copy, like a boost, and rendered as Mastodon 4.5's `Status.quote`. Every status now carries `quote` (`null` when there is none). Adds `BackendEntry.quote` to `@dwk/mastodon-api`.

Reply, boost and quote hydration now trust only the author's own `Create`/`Update` (same origin as the post, newest first), so a peer can no longer show forged, misattributed or pre-edit content under another server's post. The inbox lookup is indexed.
