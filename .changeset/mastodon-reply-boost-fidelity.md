---
"@dwk/activitypub": minor
"@dwk/mastodon-api": minor
---

Resolve two Mastodon read-surface fidelity gaps for locally-held targets. The actor DO gains `#resolveLocalObject` (pure SQL over its owner outbox then inbox, never an outbound fetch): a reply whose `inReplyTo` names a post the DO holds now carries that post's snowflake as `in_reply_to_id` plus its author as `in_reply_to_account_id` (the owner account when replying to the owner's own post), and a bare-IRI `Announce` of a locally-held post now hydrates its reblog with the real content and author instead of rendering content-less. Targets the DO does not hold still degrade to `null`/content-less as before — dereferencing a remote object is the remaining increment. New optional `BackendEntry.inReplyTo`/`BackendEntry.boost` fields carry the resolution through the adapter into `statusEntity`.
