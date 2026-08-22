---
"@dwk/atproto-pds": minor
---

Add **secp256k1 (K-256) commit signing** as an opt-in alternative to the default
P-256, the first step toward network parity with a full PDS (#181, part of #180).

secp256k1 is AT Protocol's network-preferred curve and the one existing Bluesky
accounts already sign with, so it is a prerequisite for being a drop-in target
for a migrated account. WebCrypto cannot do K-256, so it is implemented over the
audited `@noble/curves` `secp256k1` (deterministic RFC 6979, low-S, compact
64-byte `r‖s` over the SHA-256 digest — matching the P-256 path). Measured bundle
cost is ≈35 KB minified, negligible against the Worker script-size budget.

- New config `signingCurve?: "p256" | "secp256k1"` (defaults to `"p256"`). The
  curve is **fixed at repository genesis** and persisted alongside the key, so
  verification never has to infer it from raw key bytes (both curves are 65 bytes
  uncompressed).
- The DID document publishes the key as a curve-correct `Multikey` —
  multicodec `0xe7` (`secp256k1-pub`, `zQ3sh…`) or `0x1200` (`p256-pub`,
  `zDn…`).
- New public API: `createRepoKeypair`, `loadSigner`, and the `SigningCurve` /
  `RepoKeypair` / `Signer` types. `verifyData`, `verifyCommit`,
  `publicKeyMultibase`, and `didKeyFromPublicKey` take an optional trailing
  `curve` argument (defaulting to `"p256"`, so existing call sites are
  unaffected).

P-256 remains the dependency-free default; `did:web` identity, single-account
scope, and the rest of the as-built behaviour are unchanged.
