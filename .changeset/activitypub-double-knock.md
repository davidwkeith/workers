---
"@dwk/activitypub": minor
---

Sign outbound deliveries with RFC 9421 HTTP Message Signatures first, falling back to draft-cavage when a peer rejects them ("double-knock"). Peers that only accept draft-cavage are remembered per actor for 7 days. Adds `signRequestRfc9421`; `deliverActivity`'s trailing `now`/`timeoutMs` arguments move into a `DeliveryOptions` object (with the new `preference`), and `DeliveryResult` now reports the accepted `profile` on success.
