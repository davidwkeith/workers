---
"@dwk/activitypub": minor
"@dwk/mastodon-api": minor
---

Hydrate remote Mastodon client accounts from an alarm-driven ActivityPub actor
cache, include the owner's outbox posts in the home timeline, and expose
stored reply, favourite, and reblog counts on statuses. Outbox timeline IDs
use the snowflake source bit, preserving existing inbox IDs and marker
positions.
