---
"@dwk/micropub": minor
---

Deleting a post retracts its fediverse copies: an AS2 `Delete` goes to the actor's outbox for each `syndication` URL that is one of the actor's own outbox objects (`fediverse.outboxUrl`, defaulting to the one beside `publishUrl`). `retractFediverseCopies` is exported.
