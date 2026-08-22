---
"@dwk/activitypub": minor
---

Blind-addressed (`bto`/`bcc`) restricted delivery from the outbox (#496):
both owner publish seams accept blind recipients (`PostInput` gains `bto`),
each delivered individually to the recipient's **own** inbox — never a shared
inbox, since the payload has its blind addressing stripped per AP §6.1. An
activity addressed only blindly is restricted: no follower fan-out, no
community `audience` delivery, and it never surfaces in the public outbox
collection or NodeInfo counts. Blind delivery remains best-effort,
honor-system distribution — addressing is a delivery hint, not access
control.
