# @dwk/http-signatures

HTTP Message Signatures (RFC 9421 + draft-cavage) — a cross-standard reusable.

## What this is

Signs and verifies HTTP messages using both the modern RFC 9421 standard and the
legacy draft-cavage profile needed for existing fediverse federation. Covers
configurable covered components (`@method`, `@target-uri`, `host`, `date`,
`Content-Digest`), Content-Digest creation/verification, and WebCrypto-based
asymmetric algorithms (RSA-PKCS1-v1_5, RSA-PSS, Ed25519, ECDSA). No symmetric
signatures, no `none` algorithm.

## Spec

`spec/packages/http-signatures.md` — authoritative requirements.

## Key constraints

- **Protocol-agnostic.** Used by ActivityPub for S2S delivery, but must not
  import or assume any ActivityPub/fediverse specifics.
- **No Cloudflare imports.** Pure WebCrypto + standard APIs.
- **No dependencies.** Zero runtime deps — keep it that way.
- **Algorithm allowlist.** Only explicitly supported algorithms; never accept
  `none` or HMAC.
- **Key validation.** Enforce RSA minimum key size, curve validation for EC keys.

## Test environment

Node (`environment: "node"`). No Miniflare.

```bash
pnpm test --project @dwk/http-signatures
```

## File layout

```
src/index.ts       # public surface: signMessage, verifyMessage, digest helpers, types
src/types.ts       # shared plain-data message + algorithm types
src/sign.ts        # unified signing entry point, dispatches on wire profile
src/verify.ts      # unified verification: profile auto-detect + digest check
src/rfc9421.ts     # RFC 9421 wire profile: Signature-Input/Signature pair
src/cavage.ts      # legacy draft-cavage "Signature" profile for fediverse interop
src/components.ts  # covered-component value derivation (RFC 9421 §2.1–2.2)
src/sf.ts          # focused RFC 8941 structured-fields parser
src/digest.ts      # Content-Digest (RFC 9530) + legacy Digest (RFC 3230) helpers
src/algorithms.ts  # algorithm allow-list + Web Crypto sign/verify primitives
src/base64.ts      # base64 / base64url ⇄ bytes helpers
src/*.test.ts      # colocated tests
```

## Depended on by

`@dwk/activitypub`
