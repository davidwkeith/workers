---
"@dwk/vc": patch
---

Verification-side hardening from a VC standards-compliance audit (issue #98):

- **Enforce `@context` consistency on verify.** `verifySingleProof` now requires
  the secured document's `@context` to begin with every value in the proof's
  `@context`, in order (vc-di-eddsa §3.3.2 step 4.1); a divergence yields
  `verified: false` instead of being ignored.
- **Constrain `proofValue` to base58-btc on verify.** Both JCS cryptosuites
  mandate a `z`-prefixed (base58-btc) `proofValue`; verification now rejects any
  other multibase encoding (e.g. base64url `u`) rather than silently decoding it.
- **Error on an invalid `created` datetime at signing.** `addProof` validates the
  proof's `created` against the XSD `dateTimeStamp` lexical space and throws on a
  malformed value (vc-di-eddsa §3.3.5 step 3); `buildCredential` and
  `buildStatusListCredential` validate `validFrom`/`validUntil` the same way.
- **`checkValidityPeriod` fails closed.** A present-but-unparseable `validUntil`
  is treated as expired (and a malformed `validFrom` as not-yet-valid) instead of
  being read as "no expiry"; bounds must be valid XSD `dateTimeStamp`s.
- **Status-list caching bounds.** `buildStatusListCredential` accepts `validFrom`
  / `validUntil` and now advertises `ttl` on the credential as well as its
  subject.
- **One-or-more `statusPurpose`.** The status-list credential/entry builders and
  `findStatusEntry` accept an array of purposes, per the Bitstring Status List
  spec.

New exports: `isValidXsdDateTimeStamp`, `toXsdDateTime`, and the
`StatusPurposeValue` type.
