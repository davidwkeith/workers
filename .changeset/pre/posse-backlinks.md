---
"@dwk/activitypub": minor
"@dwk/micropub": minor
---

POSSE back-links between a Micropub post and its fediverse copy. `@dwk/activitypub`: a shaped `PostInput` takes `url` (emitted as the object's AS2 `url`), and outbox activities and their objects now dereference at their IRIs (`410` Tombstone once deleted, latest `Update` served, browsers redirected to `url`). `@dwk/micropub`: syndicated posts send their permalink as `url` and record the copy's object IRI as the entry's `syndication`.
