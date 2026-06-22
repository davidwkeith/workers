---
"@dwk/webdav": minor
---

Add `@dwk/webdav` — a **WebDAV (RFC 4918, Class 2)** façade over a Solid pod, so
the storage a user already owns can be mounted as a network drive by the file
managers built into every major OS (Finder, Explorer, GNOME/KDE, iOS Files) with
zero install. It is "one pod, a second door": WebDAV exposes the _same_ resources
`@dwk/solid-pod` serves, not a parallel tree.

This first beta ships the pure, Workers-runtime-free **protocol core**, all
unit-tested:

- **Bounded, XXE-safe XML** (`parseXml`, `escapeXml`) — a hand-rolled generator
  and recursive-descent parser for the small WebDAV bodies, with caps on size and
  nesting depth, `DOCTYPE`/external-entity rejection, UTF-8-only enforcement, and
  predefined-entity-only decoding.
- **Scoped app passwords** (`mintAppPassword`, `verifyAppPassword`) — the auth
  bridge for OS clients that speak Basic only: a ≥128-bit secret bound to
  `(WebID, label, scope, expiry)`, stored only as a salted PBKDF2-HMAC-SHA-256
  hash and verified in constant time.
- **`Content-Type` negotiation** and **`If` precondition header** parsing.

The `createWebdav` request handler, Class 2 locking, and the per-pod Durable
Object integration land in subsequent increments — see
`spec/packages/webdav.md` for the four load-bearing decisions. Tracked in #169.
