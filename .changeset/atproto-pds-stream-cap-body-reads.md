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
(`src/body.ts`) that allocates a single buffer sized to the configured
limit (`maxBlobSizeBytes` / `maxImportCarSizeBytes`) up front and writes
each chunk directly into it, cancelling the reader the instant a chunk
would overflow it — so the read never allocates or copies more than that
limit regardless of what `Content-Length` claims or omits, and never
briefly holds both the raw chunks and a second merged copy at once. This
closes the "buffer first, check later" gap; it does not by itself
guarantee the DO can never exceed its memory ceiling: `maxImportCarSizeBytes`
still defaults to 128 MiB, the same order of magnitude as the DO's 128 MB
limit, so a fully honest, in-cap import at the default remains a real
memory risk that a smaller configured cap should address. Note the
pre-allocated buffer itself costs the full configured limit momentarily on
every call, even for a small body — a deliberate trade for a single,
provable allocation bound instead of an accumulate-then-copy approach.
