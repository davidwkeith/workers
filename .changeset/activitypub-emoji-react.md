---
"@dwk/activitypub": minor
"@dwk/mastodon-api": minor
---

Accept Pleroma/Akkoma `EmojiReact` activities: they are stored like a `Like`, count toward `favourites_count`, and show as `favourite` notifications in the Mastodon client API. An `Undo` of a `Like` or `EmojiReact` now removes the stored reaction; previously un-favouriting was ignored. Only the reaction's own actor can undo it.
