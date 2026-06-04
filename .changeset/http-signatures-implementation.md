---
"@dwk/http-signatures": minor
---

Add `@dwk/http-signatures` — HTTP Message Signatures (RFC 9421) sign/verify with
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
