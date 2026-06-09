# @dwk/dpop

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.

## 0.1.0-beta.0

### Minor Changes

- 171749e: Implement `@dwk/dpop` — DPoP (RFC 9449) proof verification. A pure,
  runtime-agnostic `verifyDpopProof` that checks the JOSE header (`dpop+jwt`
  `typ`, asymmetric `alg` allow-list, public-only `jwk`), the signature, and the
  `htm`/`htu`/`iat`/`jti` claims; computes the RFC 7638 `jkt` thumbprint; and
  supports the Resource Server `ath` and `cnf.jkt` bindings.
- 28a1693: Add support for a server-provided DPoP nonce (issue #99, RFC 9449 §8/§9):
  - `DpopVerifyInput` gains an optional `expectedNonce`. When set, the proof's
    `nonce` claim MUST equal it, else the proof is rejected with the new
    `nonce_mismatch` reason (RFC 9449 §4.3 step 10).
  - `DpopVerifyResult` now surfaces the proof's `nonce` on both success and a
    `nonce_mismatch`, so an AS/RS adopting the `DPoP-Nonce` mechanism can answer a
    mismatch with a `use_dpop_nonce` error and a fresh nonce. Issuing and rotating
    the nonce remains the caller's responsibility.

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.

### Patch Changes

- cdda653: Harden `verifyDpopProof` (issue #42):
  - Require `expectedJkt` whenever `accessToken` is supplied. Enforcing `ath`
    without the `cnf.jkt` binding let a proof made for the token but signed by any
    key validate, defeating proof-of-possession (RFC 9449 §7.1); this is now
    rejected with the new `jkt_required` reason.
  - Validate the EC `crv` against the curve the `alg` implies (`ES256`⇒`P-256`,
    `ES384`⇒`P-384`), rejecting a mismatch with `crv_mismatch` before import.
  - Reject RSA keys whose modulus is below 2048 bits with `rsa_key_too_small`.
  - Reject any JWS carrying a `crit` header parameter with `crit_unsupported`
    (RFC 7515 §4.1.11).

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.
