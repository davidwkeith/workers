---
"@dwk/micropub": minor
---

Accept `visibility: "contacts"` on Micropub create/update, extending the
stable Visibility extension's `VISIBILITY_VALUES` enum alongside the existing
`public` | `unlisted` | `private` values (#498). Kept as a string enum (not a
boolean) so finer audience tiers can layer on later without breaking stored
posts. As with `unlisted`/`private`, this package only stores and advertises
the value — enforcing membership against a contact allowlist is the serving
layer's responsibility, not this endpoint's.
