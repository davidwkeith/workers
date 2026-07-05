---
"@dwk/atproto-pds": patch
---

`resolveDidDocument`'s `did:web` fetch now goes through `@dwk/safe-fetch`
(#215): a bounded timeout and a private/reserved-host block where previously
there was neither.
