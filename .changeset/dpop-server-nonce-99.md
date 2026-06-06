---
"@dwk/dpop": minor
---

Add support for a server-provided DPoP nonce (issue #99, RFC 9449 §8/§9):

- `DpopVerifyInput` gains an optional `expectedNonce`. When set, the proof's
  `nonce` claim MUST equal it, else the proof is rejected with the new
  `nonce_mismatch` reason (RFC 9449 §4.3 step 10).
- `DpopVerifyResult` now surfaces the proof's `nonce` on both success and a
  `nonce_mismatch`, so an AS/RS adopting the `DPoP-Nonce` mechanism can answer a
  mismatch with a `use_dpop_nonce` error and a fresh nonce. Issuing and rotating
  the nonce remains the caller's responsibility.
