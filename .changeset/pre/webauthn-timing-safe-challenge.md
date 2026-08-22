---
"@dwk/webauthn": patch
---

Compare the WebAuthn challenge with a constant-time byte comparison
(`crypto.subtle.timingSafeEqual`) instead of a plain string `!==`, closing a
timing side channel on challenge verification.
