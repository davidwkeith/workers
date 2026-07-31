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
exceeds the configured limit, so the buffer never grows past the cap
regardless of what `Content-Length` claims or omits.
