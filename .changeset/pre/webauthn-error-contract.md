---
"@dwk/webauthn": patch
---

Wrap ceremony dispatch (both the per-relying-party Durable Object and the
front door's invocation of it) in try/catch. A parse or verification failure
that previously escaped as an unhandled exception now returns the package's
structured `{error}` JSON contract.
