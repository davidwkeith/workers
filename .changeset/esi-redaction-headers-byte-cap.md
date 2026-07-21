---
"@dwk/esi": patch
---

Fragment failure logs (`esi.fragment.failed`, `esi.include.dropped_max_includes`)
now record only the host of a `src`/`alt` URL (via `@dwk/log`'s `hostFromUrl`)
instead of the full URL, matching every other package's redaction rule for
attacker- or user-supplied URLs.

`processEsi` now strips `ETag` and `Last-Modified` from the transformed
response alongside `Content-Length` — none of the three still describe the
transformed body, and carrying `ETag`/`Last-Modified` through unchanged could
serve a stale cached representation on a client's conditional request.

The tokenizer's pending-tag buffer cap (`MAX_PENDING_BYTES`, 8192) is now
measured by UTF-8 byte length instead of the JS string's own `.length`
(UTF-16 code units) — a multi-byte-heavy payload (CJK text, emoji) could
previously grow the buffer well past the intended byte budget before the cap
noticed.

Added `spec/packages/esi.md`, the only package previously missing one.
