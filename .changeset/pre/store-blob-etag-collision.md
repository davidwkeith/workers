---
"@dwk/store": patch
---

Fix content-addressed blob keys causing cross-resource ETag collisions and
shared `Content-Type` overwrites (#40). Blob keys stay content-addressed
(`sha256-…`) so identical bytes still dedupe to one R2 object, but two side
effects are removed:

- **ETag collisions:** `putBlob` derived the ETag from the content hash, so two
  distinct resources holding identical bytes returned the same ETag — an
  `If-Match` against resource A's ETag would also be satisfied by an unrelated
  resource B. Blob ETags are now fresh per-write opaque validators
  (`randomEtag()`), matching how RDF writes already behave, while the content
  hash remains the R2 key for dedup.
- **Shared-key `Content-Type` overwrite:** each write re-`put` the shared
  content-addressed object with its own `httpMetadata.contentType`, so a
  direct/public bucket read of one resource could return another writer's
  content type. The per-object `httpMetadata` claim is dropped; the
  authoritative content type lives on the per-resource pointer and reads go
  through the Worker.
