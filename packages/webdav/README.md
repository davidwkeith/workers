# @dwk/webdav

A **WebDAV (RFC 4918, Class 2)** façade over a [Solid pod](../solid-pod), so the
storage a user already owns can be **mounted as a network drive by the file
managers built into every major OS** — macOS Finder, Windows Explorer, the
GNOME/KDE managers, iOS Files — with zero install and no app.

It is **one pod, a second door**: WebDAV exposes the _same_ resources
`@dwk/solid-pod` serves, not a parallel tree, so the files you reach in Finder
_are_ your pod. Solid gives the pod meaning (RDF, LDP, WAC, N3 Patch); WebDAV
gives the user a way to touch their files from hardware they already own.

> **Status: in progress.** This package is being built bottom-up from
> [`spec/packages/webdav.md`](../../spec/packages/webdav.md). The current entry
> point ships the pure **protocol core**; the `createWebdav` request handler,
> Class 2 locking, and the per-pod Durable Object integration land in subsequent
> increments. See the spec for the four load-bearing decisions.

## What's implemented today (protocol core)

All pure, Workers-runtime-free, and unit-tested:

- **Bounded, XXE-safe XML** (`parseXml`, `escapeXml`) — a hand-rolled generator
  and recursive-descent parser for the small WebDAV bodies, with caps on size
  and nesting depth, `DOCTYPE`/external-entity rejection, UTF-8-only enforcement,
  and predefined-entity-only decoding. (spec §4)
- **Scoped app passwords** (`mintAppPassword`, `verifyAppPassword`) — the auth
  bridge for OS clients that speak Basic only: a ≥128-bit secret bound to
  `(WebID, label, scope, expiry)`, presented under a colon-free credential id,
  stored only as a salted PBKDF2-HMAC-SHA-256 hash, verified in constant time.
  (spec §1)
- **Strict `If:` parser** (`parseIfHeader`) — a documented subset (one untagged
  list of one lock token and/or one ETag); anything more complex is reported
  `unsupported`. (spec §4)
- **OS-client quirks** (`inferContentType`, `isOsLitter`) — extension-based
  content-type inference for generic `PUT`s, and OS-litter detection. (spec §3)

## License

ISC
