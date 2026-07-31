---
"@dwk/webauthn": patch
---

Cap the CBOR decoder's recursion depth at 32 levels. A crafted `attestationObject`
with deeply nested arrays/maps could previously stack-overflow the Worker
(denial of service); it now throws `CborError` instead.
