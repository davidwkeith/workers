---
"@dwk/webmention": minor
---

Recognize Indie RSVPs. During asynchronous verification, a source that carries a
`p-rsvp` (`yes`/`no`/`maybe`/`interested`) plus a `u-in-reply-to` aimed at the
target is detected as an RSVP and its value persisted on the inbox record (new
nullable `rsvp` column, migrated additively on existing inboxes). Extraction is a
bounded `HTMLRewriter` read of just those two properties — no full microformats2
parser enters the Worker bundle. Exports `extractRsvp`, `isRsvpValue`,
`RSVP_VALUES`, and `RsvpValue`; `VerifyResult` and `VerifiedMention` gain an
optional `rsvp`. Part of the calendar/events work (#168).
