---
"@dwk/webauthn": patch
---

Add a per-operation `authorize` hook so registration can be gated (#293).
`register/options` and `register/verify` bind a passkey to a caller-supplied
`user.id`; with no way to require authentication, a composition that mounted the
handler unauthenticated let anyone register their own authenticator against
another user's id and then authenticate as that user — account takeover.

`WebAuthnConfig` now accepts `authorize(operation, request) => boolean`,
consulted by the front door before any Durable Object state is touched; a
`false` result returns `401`. The default is allow-all (matching `@dwk/vc`), so
existing behaviour is unchanged, but the field doc and README now loudly direct
the composing front door to gate the `register/*` operations behind an
authenticated session. The hook is not forwarded to the DO.

When no `authorize` hook is supplied, `createWebAuthn` now emits a loud
`webauthn.config.registration_unguarded` warning on the injected logger at
startup rather than degrading silently, so an accidentally-open registration
surface is visible in logs (composition-contract "no silent degradation"
posture). It stays advisory — upstream gating at the front door is a valid
pattern the package cannot observe.
