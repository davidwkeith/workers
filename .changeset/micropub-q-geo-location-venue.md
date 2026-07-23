---
"@dwk/micropub": minor
---

Add the proposed Location/Venue (`q=geo`) extension: a read-only proximity
search over an injected, strongly-consistent venue store, independent from
post storage. Disabled by default — requires `extensions.proposed: true` and a
configured `venues` store (`createMicropubVenueStore` for the built-in
D1-backed implementation). Accepts a Geo URI or discrete `lat`/`lon`
coordinates plus an optional `u` radius (default 1,000m, max 50,000m), and
returns venues ordered by great-circle distance with `limit`/`offset`
pagination. `geo`'s location suggestion is currently a placeholder that echoes
the query coordinates back — no reverse-geocoding service is wired in yet.

Implements the design from #359 per
https://indieweb.org/Micropub-extensions#Location/Venue. Tracked by #354.
