---
"@dwk/atproto-pds": patch
---

Reject an oversized migration CAR by its declared `Content-Length` before
buffering it in `#importRepo`, mirroring the existing `#uploadBlob` size
check instead of buffering an unbounded body.
