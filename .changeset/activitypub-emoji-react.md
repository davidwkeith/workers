---
"@dwk/activitypub": minor
---

Accept Pleroma/Akkoma `EmojiReact` activities: they are stored like a `Like` and count toward `favourites_count`. An `Undo` of a `Like` or `EmojiReact` now removes the stored reaction; previously un-favouriting was ignored. Only the reaction's own actor can undo it.
