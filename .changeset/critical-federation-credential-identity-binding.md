---
"@dwk/activitypub": patch
"@dwk/vc": patch
---

Close two critical identity-binding gaps found in the pre-1.0 code review, both
on unauthenticated / attacker-controlled paths:

- **`@dwk/activitypub`: actor impersonation via the default key resolver
  (#287, #288).** Inbound HTTP-signature verification trusted the `owner`
  field of whatever document the attacker-supplied `keyId` served, so a key
  document hosted at `https://evil.example/key` could declare
  `owner: https://victim.example/users/alice` and have signed activities
  attributed to the victim. The default resolver now binds the resolved
  `owner` to the origin that **actually served** the key — the final URL after
  any redirects, not the requested `keyId`, so an open redirect on the
  requested origin cannot smuggle attacker-served content in under it — and the
  `keyId` fetch runs through `@dwk/safe-fetch`'s
  `safeFetch` — `https:`-only, with private/loopback/link-local hosts blocked
  and **every redirect hop re-validated** (so a public host cannot `302` the
  fetch onto an internal address), plaintext `http:` no longer accepted, and a
  bounded, size-capped body read — instead of an unguarded `fetch`.

- **`@dwk/vc`: credential forgery via unbound `verificationMethod` (#289).**
  Proof verification never tied the proof's `verificationMethod` to the
  credential's `issuer`, so a credential naming any `issuer` could be signed
  with an attacker's own key and still verify. `verifySingleProof` now
  requires the verification method's controller (its declared `controller`,
  or the DID/URL portion of the method id) to equal the credential's issuer
  before the key is trusted. A new optional `expectedController` on
  `VerifyProofOptions` allows overriding the bound party for non-issuance
  proof purposes (e.g. a presentation's `authentication` proof).
