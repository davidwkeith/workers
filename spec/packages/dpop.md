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
  - standard proof validity (signature, `iat` window, `jti` presence).
- Surface the verified `jti` so callers can enforce replay policy
  (`@dwk/solid-pod` enforces strict `jti` replay in the DO for writes; reads MAY
  use a short edge-cached window).

## Design constraints

- **Plain-data inputs only** — request facts, the proof, and the token claims
  are passed in; the package returns a verification result. It MUST unit-test
  **without a Workers runtime**.
- **Protocol-agnostic:** no IndieWeb- or Solid-specific claim handling baked in.
  Caller supplies issuer/audience expectations.

## Testing

- Unit tests with crafted proofs: happy path, `htu`/`htm` mismatch, `cnf.jkt`
  mismatch, expired/early proofs, missing `jti`.
