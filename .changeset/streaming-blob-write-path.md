---
"@dwk/store": patch
"@dwk/solid-pod": patch
"@dwk/micropub": patch
---

Stop buffering the full body on the blob **write** path, honouring the
"stream R2 bodies through the Worker — never buffer a blob in the DO" mandate
(#31). Previously three write paths materialised the entire body in memory —
exactly for the oversized bodies routed to R2 because they exceed the ~2 MB cell
ceiling (up to the 128 MB limit).

- `@dwk/store`: `putBlob` now accepts a `ReadableStream`/`Blob` and hashes it
  with a `DigestStream` while streaming it to a staging key, then promotes the
  staged object to its content-addressed key (skipped when an identical body
  already exists, so writes still dedupe) — the DO never holds the whole body.
  In-memory `ArrayBuffer`/`Uint8Array` inputs keep the direct write path.
- `@dwk/solid-pod`: `#writeBody` routes on the declared `Content-Length` — a
  body known to fit the cell is read into memory (bounded) and, if RDF, parsed
  into quads; anything larger is streamed straight to R2. An undeclared length
  is probed only up to the ceiling; a body that overflows the probe is rejected
  with `411 Length Required` rather than buffered whole. The front door forwards
  `Content-Length` to the DO for this routing.
- `@dwk/micropub`: the media endpoint and multipart create now reject an upload
  whose `Content-Length` exceeds `maxMediaBytes` (with `413`) _before_
  `formData()` reads the body into memory.
