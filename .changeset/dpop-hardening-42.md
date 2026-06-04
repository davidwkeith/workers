---
"@dwk/dpop": patch
---

Harden `verifyDpopProof` (issue #42):

- Require `expectedJkt` whenever `accessToken` is supplied. Enforcing `ath`
  without the `cnf.jkt` binding let a proof made for the token but signed by any
  key validate, defeating proof-of-possession (RFC 9449 §7.1); this is now
  rejected with the new `jkt_required` reason.
- Validate the EC `crv` against the curve the `alg` implies (`ES256`⇒`P-256`,
  `ES384`⇒`P-384`), rejecting a mismatch with `crv_mismatch` before import.
- Reject RSA keys whose modulus is below 2048 bits with `rsa_key_too_small`.
- Reject any JWS carrying a `crit` header parameter with `crit_unsupported`
  (RFC 7515 §4.1.11).
