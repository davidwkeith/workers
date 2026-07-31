---
"@dwk/atproto-pds": patch
---

Stream-cap `#uploadBlob` and `#importRepo`'s request body reads instead of
buffering the whole body before checking its size. The declared
`Content-Length` pre-check (added in a prior patch) only helped when the
header was present and truthful — a request with no `Content-Length` (or an
understated one, e.g. via chunked transfer-encoding) still buffered
unbounded into memory before the post-hoc length check ran. The body is now
read incrementally via a local `readRequestBodyCapped` helper
(`src/body.ts`) that cancels the reader the instant the running total
exceeds the configured limit, so the buffer this builds is bounded by that
limit (`maxBlobSizeBytes` / `maxImportCarSizeBytes`) regardless of what
`Content-Length` claims or omits — this closes the "buffer first, check
later" gap, it does not by itself guarantee the DO can never exceed its
memory ceiling: `maxImportCarSizeBytes` still defaults to 128 MiB, the same
order of magnitude as the DO's 128 MB limit, so a fully honest, in-cap
import at the default remains a real memory risk that a smaller configured
cap should address.
