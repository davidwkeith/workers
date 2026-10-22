---
"@dwk/safe-fetch": patch
---

Strip HTTP signature headers (`Signature`, `Signature-Input`) on a cross-origin redirect, alongside the existing credential headers. A signature is bound to its original target, so forwarding it would let the redirect target replay it.
