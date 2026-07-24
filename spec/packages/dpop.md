# `@dwk/dpop`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Used by** | [`@dwk/indieauth`](indieauth.md) token validation, [`@dwk/solid-pod`](solid-pod.md) Resource Server |

DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)) proof verification. A
**cross-standard reusable**: it MUST stay free of IndieWeb/Solid assumptions so
future `@dwk` packages can adopt it unchanged.

## Functional requirements

- Verify a DPoP proof JWT and its binding to an access token:
  - proof `htu` (HTTP target URI) and `htm` (method) match the request,
  - `cnf.jkt` (the token's confirmation thumbprint) matches the proof key,
  - standard proof validity: the JOSE `typ` header is exactly `dpop+jwt`
    (RFC 9449 §4.2 — guards against JWT mix-up / reuse), valid signature, `iat`
    within an acceptable window, and `jti` present.
- Surface the verified `jti` so callers can enforce replay policy
  (`@dwk/solid-pod` enforces strict `jti` replay in the DO for writes only —
  reads are idempotent and side-effect-free, so this package does not itself
  gate on any read-side replay window; a config knob for one was dropped
  from `@dwk/solid-pod` in the #313 cleanup after being found unwired).

## Design constraints

- **Plain-data inputs only** — request facts, the proof, and the token claims
  are passed in; the package returns a verification result. It MUST unit-test
  **without a Workers runtime**.
- **Protocol-agnostic:** no IndieWeb- or Solid-specific claim handling baked in.
  Caller supplies issuer/audience expectations.
- **Algorithm allow-list:** `DpopAlgorithm` is
  `ES256 | ES384 | ES512 | EdDSA | RS256 | PS256`. Symmetric (`HS*`) and
  `none` are excluded on purpose — a DPoP proof must be signed by the
  client-held private key whose public half is the embedded `jwk`. `EdDSA`
  accepts Ed25519 (RFC 8037 OKP keys) only: Ed448 has no Web Crypto support
  in the Workers runtime, so an Ed448 `jwk` is rejected as `crv_mismatch`.
- **`htu` has no port allow-list.** `htu` binding is exact-match string
  comparison after normalization (scheme + host + path, port included when
  non-default); the package does not restrict which ports a caller's
  configured endpoint may use. This is deliberately silent in RFC 9449 too —
  noted here so it isn't mistaken for an oversight.

## Testing

- Unit tests with crafted proofs: happy path, `htu`/`htm` mismatch, `cnf.jkt`
  mismatch, expired/early proofs, missing `jti`.
