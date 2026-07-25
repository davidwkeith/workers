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
