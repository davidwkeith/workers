---
"@dwk/webdav": patch
---

Tighten the Class 2 verb router's RFC 4918 conformance ahead of the hosted
litmus run (#169), closing six gaps a spec review surfaced:

- **`If:` header strictness (§10.4).** A header outside the supported subset
  (tagged lists, `Not`, multiple state tokens) is now answered `400` instead of
  being silently treated as "no token" — making good on the spec §4 promise to
  reject rather than guess, and closing a fail-_open_ path where a dropped
  conditional could let an unintended write through.
- **`If:` `[etag]` is now enforced (§10.4.2).** The header's ETag production is
  mapped onto the TOCTOU-free `If-Match` precondition (an explicit `If-Match`
  still wins) instead of being parsed and ignored.
- **`Allow` on every `405` (RFC 7231 §6.5.5).** Unknown methods, `PUT` on a
  collection, and a duplicate `MKCOL` now carry the mandatory `Allow` header.
- **`PROPFIND Depth: infinity`** returns the `<DAV:propfind-finite-depth/>`
  precondition marker (§9.1) instead of a plain-text `403`.
- **`423 Locked`** on `DELETE`/`MOVE`/`PROPPATCH` now carries the
  `<DAV:lock-token-submitted>` body (§16), as `PUT` already did, so clients learn
  which token to resubmit.
- **Cross-server `COPY`/`MOVE`** `Destination` is answered `502` (§9.8.5/§9.9)
  rather than `400`.

Per-member `207 Multi-Status` failure reporting for collection
`DELETE`/`COPY`/`MOVE` remains a documented v1 simplification.
