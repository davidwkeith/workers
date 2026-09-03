---
"@dwk/activitypub": minor
---

Emit the actor document's `url` — the human-facing profile page a peer's "open
original profile" action follows — defaulting to the `baseUrl` root (v1 serves
one actor per `baseUrl`, so the site's home page is the profile) and overridable
via `actor.url` (validated as an absolute URL at startup — a relative or
malformed override throws, like the other config checks). Without it every platform fell back to the actor `id`, i.e. the
AS2 JSON document itself.
