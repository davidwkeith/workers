---
"@dwk/webdav": patch
"@dwk/solid-pod": patch
---

Address code-review follow-ups on the litmus conformance fixes:

- `verifyAppPassword` now returns `false` instead of throwing when a
  record's `iterations` exceeds workerd's PBKDF2 ceiling, restoring its
  documented "never throws" contract for any record regardless of
  provenance (imported/migrated data, or anything minted outside
  `mintAppPassword`).
- `COPY`/`MOVE` onto a destination whose immediate parent collection
  doesn't exist now `409`s instead of auto-vivifying it, closing the same
  RFC 4918 §9.8.5/§9.9.4 gap already fixed for `MKCOL`/`PUT`.
