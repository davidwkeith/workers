# @dwk/ldn

Linked Data Notifications primitives — a cross-standard reusable.

## What this is

RDF-only LDN protocol helpers shared by `@dwk/solid-pod` and `@dwk/activitypub`.
Provides vocabulary IRIs (LDP namespace constants), inbox discovery helpers
(`inboxLinkHeader`, `discoverInboxIris`), notification parsing/validation
(`parseNotification`), and inbox-listing quad builders. The discovery helpers are
available n3-free via the `@dwk/ldn/discovery` subpath export for Workers-runtime
consumers that don't want to pull in N3.js.

## Spec

`spec/packages/ldn.md` — authoritative requirements.

## Key constraints

- **Protocol-agnostic.** Shared between Solid and ActivityPub inboxes. Must not
  leak WAC, Solid, or ActivityPub specifics.
- **No Cloudflare imports.** Pure-data library. Tests under Node.
- **Subpath export.** `@dwk/ldn/discovery` must remain n3-free — it exposes only
  `Link` header parsing and IRI extraction, no RDF parsing.
