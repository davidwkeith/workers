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
(`src/body.ts`) into a resizable `ArrayBuffer` (`maxByteLength:` the
configured limit — `maxBlobSizeBytes` / `maxImportCarSizeBytes`), grown by
exactly each chunk's size as it arrives and cancelling the reader the
instant a chunk would grow it past the limit. Memory committed tracks the
bytes actually received, not the configured limit — a small body costs
proportionally little, not the full cap — while the limit is still a hard
ceiling the buffer can never be grown past, regardless of what
`Content-Length` claims or omits. This closes the "buffer first, check
later" gap; it does not by itself guarantee the DO can never exceed its
memory ceiling: `maxImportCarSizeBytes` still defaults to 128 MiB, the same
order of magnitude as the DO's 128 MB limit, so a fully honest import that
actually reaches the default cap remains a real memory risk that a smaller
configured cap should address.
