# @dwk/dpop

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

## 0.1.0-beta.4

### Minor Changes

- dc59912: Widen the DPoP proof algorithm allow-list with `EdDSA` (Ed25519, RFC 8037 OKP keys — including the OKP RFC 7638 thumbprint) and `ES512` (P-521 + SHA-512). The spec had marked both "not implemented yet — widen on demand"; Ed25519 in particular is where fediverse client signing is converging. Ed448 stays rejected (`crv_mismatch`) — the Workers runtime has no Web Crypto support for it. Symmetric algorithms and `none` remain excluded.

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.

## 0.1.0-beta.3

### Patch Changes

- 6d14fc3: Fix: emit explicit `.js` extensions on relative imports so the published ESM
  packages resolve under Node's ESM loader.

  The packages were built with `moduleResolution: "Bundler"`, which let source
  files omit extensions on relative specifiers (`export { createWebmention } from
"./handler"`). `tsc` preserves specifiers verbatim, so the published
  `dist/index.js` re-exported extensionless paths that Node's ESM loader cannot
  resolve — `import("@dwk/webmention")` failed with `ERR_MODULE_NOT_FOUND` (only
  a bundler like esbuild/wrangler papered over it). Relative specifiers across the
  monorepo now carry explicit `.js` extensions, and `tsconfig.base.json` moves to
  `module`/`moduleResolution: "NodeNext"` so the compiler enforces extensions and
  this cannot silently regress.

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.

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
