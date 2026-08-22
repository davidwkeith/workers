---
"@dwk/webauthn": minor
---

Add `@dwk/webauthn` — a WebAuthn / passkeys relying party. `createWebAuthn(config)`
exposes the four ceremony endpoints (`/register/options`, `/register/verify`,
`/authenticate/options`, `/authenticate/verify`) over a per-relying-party Durable
Object that mints and single-use-consumes short-TTL challenges and persists
credential records (public key, signature counter, transports) in strongly
consistent DO SQLite — never KV. Attestation (`none` and `packed`
self-attestation) and assertion verification run entirely on Web Crypto via a
minimal CBOR/COSE decoder, with no dependency beyond `@dwk/log`. Filed as an
exploratory, lowest-priority package (#64).
