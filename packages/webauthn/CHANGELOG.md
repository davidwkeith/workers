# @dwk/webauthn

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [6d14fc3]
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 6d853e6: Add `@dwk/webauthn` — a WebAuthn / passkeys relying party. `createWebAuthn(config)`
  exposes the four ceremony endpoints (`/register/options`, `/register/verify`,
  `/authenticate/options`, `/authenticate/verify`) over a per-relying-party Durable
  Object that mints and single-use-consumes short-TTL challenges and persists
  credential records (public key, signature counter, transports) in strongly
  consistent DO SQLite — never KV. Attestation (`none` and `packed`
  self-attestation) and assertion verification run entirely on Web Crypto via a
  minimal CBOR/COSE decoder, with no dependency beyond `@dwk/log`. Filed as an
  exploratory, lowest-priority package (#64).

### Patch Changes

- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
