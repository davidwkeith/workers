---
"@dwk/activitypub": minor
---

Add outbound FEP-8b32 object integrity proofs. A new optional `integrityKey` config (an Ed25519 private JWK) publishes a FEP-521a `assertionMethod` `Multikey` on the actor document and adds an `eddsa-jcs-2022` `DataIntegrityProof` to every activity the actor authors when it is delivered. Forwarded activities are never signed. A malformed key fails at startup, and a key that still fails to import in the Durable Object is logged (`activitypub.integrity.key_invalid`) and deliveries continue without a proof.
