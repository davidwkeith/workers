---
"@dwk/atproto-pds": patch
---

Two small spec-conformance follow-ups from the review:

- **`com.atproto.repo.listRecords` now honours `reverse`.** With `reverse=true`
  the listing is returned in descending record-key order and the cursor pages
  downward (`rkey < cursor`); the default (ascending) behaviour is unchanged.
- **The `did:web` DID document no longer advertises the secp256k1 key suite for a
  P-256 account.** The `@context` carried
  `https://w3id.org/security/suites/secp256k1-2019/v1` unconditionally, which is
  wrong for the default P-256 curve. The verification method is a self-describing
  `Multikey`, so `multikey/v1` covers both curves; the legacy secp256k1 suite
  context is now included only when the signing curve is secp256k1.
