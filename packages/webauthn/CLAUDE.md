# @dwk/webauthn

WebAuthn relying party (passkeys) — endpoint + Durable Object.

## What this is

Implements WebAuthn Level 3 registration and authentication ceremonies for
passkey-based authentication. Uses a per-RP Durable Object with SQLite for
challenge state (short-TTL, single-use) and credential persistence. Handles
attestation verification (self-attestation only — no x5c chain), assertion
verification, clone detection via signature counter tracking, and COSE
algorithm support (ES256, ES384, RS256, PS256).

## Spec

`spec/packages/webauthn.md` — authoritative requirements.

## Key constraints

- **Challenge single-use.** Registration/authentication options generate a
  random challenge stored in the DO. Each challenge is consumed exactly once
  and expires after a short TTL. The DO's single-threaded execution guarantees
  no race conditions.
- **Self-attestation only.** `attestation: "none"` — no attestation certificate
  chain verification. This simplifies the implementation significantly.
- **Clone detection.** The stored signature counter is checked on every
  authentication. If the new counter is not strictly greater than the stored
  value, the credential may have been cloned — the response indicates this.
- **Exploratory/low priority.** This package is a technically clean Workers
  fit but is the furthest from the core web-presence standards scope.
