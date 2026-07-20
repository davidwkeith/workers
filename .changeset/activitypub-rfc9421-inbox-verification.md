---
"@dwk/activitypub": minor
"@dwk/http-signatures": patch
---

`@dwk/activitypub`'s inbox now verifies RFC 9421 (`Signature`/`Signature-Input`)
HTTP Message Signatures in addition to the legacy draft-cavage profile, auto-detected
per request. Delegates the RFC 9421 wire format and crypto to `@dwk/http-signatures`
(now a real dependency, per issue #59) while keeping the existing draft-cavage
path — and its exact `VerifyFailureReason` vocabulary — unchanged, so no caller
needs to change. Traced from a live conformance run against Fedify (issue #273):
Fedify signs `Follow` with draft-cavage but `Create`/other activities with RFC
9421, so a target that only understood draft-cavage rejected those deliveries
as `missing_signature`.
