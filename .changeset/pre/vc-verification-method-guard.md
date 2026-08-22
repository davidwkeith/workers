---
"@dwk/vc": patch
---

Add a real runtime type guard to `findVerificationMethod` instead of blind-
casting an attacker-reachable DID document entry to `VerificationMethod`.
