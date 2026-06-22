---
"@dwk/activitypub": minor
---

Federate calendar events and RSVPs over ActivityPub (the Fediverse layer of the
calendar/events epic, #171). Add `calendarEventToActivityStreams`, the
`CalendarEvent → ActivityStreams 2.0 Event` adapter that reads the canonical
`@dwk/calendar` model so an `h-event`, a `VEVENT`, and an AS2 `Event` are three
serializations of one record; the owner publishes it through the existing
outbox seam. The inbox now handles `Join`/`Leave` — the ActivityPub mirror of an
Indie RSVP — recording participation as authoritative Durable Object state for
events this actor owns, auto-`Accept`ing a `Join` (signed `Accept` to the
participant's inbox) unless the new `manuallyApprovesJoins` config holds it
`pending`.
