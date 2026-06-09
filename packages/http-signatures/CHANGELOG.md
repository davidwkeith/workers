# @dwk/http-signatures

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.

## 0.1.0-beta.0

### Minor Changes

- 72db0ae: Add `@dwk/http-signatures` — HTTP Message Signatures (RFC 9421) sign/verify with
  the legacy `draft-cavage-http-signatures` profile for fediverse interop. A pure,
  runtime-agnostic cross-standard reusable (plain-data inputs, Web Crypto only,
  Node-testable) sitting alongside `@dwk/dpop`.
  - **`signMessage` / `verifyMessage`** over a configurable covered-component set
    (`@method`, `@target-uri`, `@authority`, `host`, `date`, `content-digest`, …).
    The profile is auto-detected on verify (`Signature-Input` ⇒ RFC 9421, else the
    single `Signature` header is parsed as `draft-cavage`).
  - **Hardened like `@dwk/dpop`:** asymmetric algorithms only from an explicit
    allow-list (`rsa-pss-sha512`, `rsa-v1_5-sha256`, `ecdsa-p256-sha256`,
    `ecdsa-p384-sha384`, `ed25519`) — never `none` or HMAC — and the resolved
    `CryptoKey` is validated against the claimed algorithm (RSA 2048-bit floor,
    EC curve) before any signature check.
  - **`created`/`expires` window** with configurable clock-skew tolerance, a
    `requiredComponents` policy, and optional **`Content-Digest` (RFC 9530) /
    legacy `Digest`** body-integrity verification.
  - **Protocol-agnostic:** key resolution is the caller's responsibility, supplied
    as a `KeyResolver`. Consumed by `@dwk/activitypub` (separate issue).

### Patch Changes

- 6a11ec4: Fix two low-severity standards-compliance nits from the audit:
  - Parse the RFC 9530 `Content-Digest` field with the strict RFC 8941
    structured-fields parser (a Dictionary of Byte Sequences) instead of
    hand-splitting on `,` and lowercasing keys. An uppercase algorithm key is no
    longer silently accepted, and members carrying parameters are parsed
    correctly; a malformed value fails closed as `digest_mismatch`.
  - Document the deliberate draft-cavage default covered-component divergence: when
    a `Signature` arrives with neither an explicit `headers` list nor `created`,
    the verifier falls back to `date` (the older "Signing HTTP Messages" rule that
    fediverse peers implement) rather than the draft-12 `(created)` default. The
    misleading code comment is corrected to describe the intentional interop
    choice.

- 44e82b5: Reject duplicate covered-component identifiers in RFC 9421 signatures. Both the
  signer and verifier now fail when a component identifier appears more than once
  in the covered-component list (e.g. `("@method" "@method")`), as RFC 9421 §2/§2.5
  requires ("each component identifier MUST occur only once"; building a signature
  base over a repeated component MUST error). Verification returns
  `components_malformed`; signing throws.
- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.
