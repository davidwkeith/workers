---
"@dwk/activitypub": patch
---

Sign outbound `GET`s (key resolution, inbox resolution, actor-profile refresh, relayed-object verification, and the `activitypub_resolve` MCP tool's actor fetch) as the actor with draft-cavage `(request-target) host date` when `privateKeyPem` is configured. Peers in Mastodon's authorized-fetch mode, such as mastodon.social, answer unsigned actor fetches with `401`, so their Follows (and every other activity) failed verification with `key_unresolved` and Accepts to them could not resolve an inbox.
