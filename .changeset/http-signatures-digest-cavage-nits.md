---
"@dwk/http-signatures": patch
---

Fix two low-severity standards-compliance nits from the audit:

- Parse the RFC 9530 `Content-Digest` field with the strict RFC 8941
  structured-fields parser (a Dictionary of Byte Sequences) instead of
  hand-splitting on `,` and lowercasing keys. An uppercase algorithm key is no
  longer silently accepted, and members carrying parameters are parsed
  correctly; a malformed value fails closed as `digest_mismatch`.
- Document the deliberate draft-cavage default covered-component divergence: when
  a `Signature` arrives with neither an explicit `headers` list nor `created`,
  the verifier falls back to `date` (the older "Signing HTTP Messages" rule that
  fediverse peers implement) rather than the draft-12 `(created)` default. The
  misleading code comment is corrected to describe the intentional interop
  choice.
