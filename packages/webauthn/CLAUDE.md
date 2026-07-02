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

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- DO: `WebAuthnObject` (useSQLite)
- Compatibility flags: `nodejs_compat`

```bash
pnpm test --project @dwk/webauthn
```

## File layout

```
src/index.ts        # public surface: createWebAuthn, WebAuthnObject, verify functions, types
src/config.ts       # WebAuthnConfig type and Env fragment
src/handler.ts      # createWebAuthn factory (routes the four ceremony steps to the DO)
src/rp.ts           # WebAuthnObject Durable Object (challenge + credential storage)
src/verify.ts       # verifyRegistration/verifyAuthentication ceremony core (pure)
src/cbor.ts         # minimal CBOR (RFC 8949) decoder (attestation object, COSE_Key)
src/cose.ts         # COSE_Key → JWK conversion, Web Crypto verify params, DER → raw ECDSA
src/encoding.ts     # base64url/byte helpers shared across the ceremonies
src/log.ts          # structured logging/metrics event vocabulary
src/test-harness.ts # test-only DO class + authenticator simulator (not published)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
