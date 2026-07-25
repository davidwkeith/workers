# @dwk/webauthn

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/log@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- bde0341: Add a per-operation `authorize` hook so registration can be gated (#293).
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

- Updated dependencies [3e505be]
  - @dwk/log@0.1.0-beta.4

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
