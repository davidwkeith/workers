# `@dwk/http-signatures`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Standard** | [HTTP Message Signatures (RFC 9421)](https://www.rfc-editor.org/rfc/rfc9421) (+ legacy `draft-cavage` profile) |
| **Used by** | [`@dwk/activitypub`](activitypub.md) server-to-server delivery |
| **Status** | implemented (unreleased) — tracked in [#59](https://github.com/davidwkeith/workers/issues/59) |

Sign and verify HTTP messages. A **cross-standard reusable** sitting alongside
[`@dwk/dpop`](dpop.md): it MUST stay free of IndieWeb / Solid / ActivityPub
assumptions so future `@dwk` packages can adopt it unchanged.

## Functional requirements

- **Sign** an outbound request over a configurable covered-component set
  (`@method`, `@target-uri`, `@authority`, `host`, `date`,
  `content-digest`, …) and emit the `Signature` / `Signature-Input` headers.
- **Verify** an inbound signature: reconstruct the signature base from the named
  components, resolve the key, and check the signature and the
  `created` / `expires` window.
- Compute and verify `Content-Digest` (RFC 9530) so body integrity is part of
  the covered set.
- Support **both** RFC 9421 and the legacy `draft-cavage-http-signatures`
  "Signature" profile that much of the fediverse still emits — real interop
  needs both.

## Design constraints

- **WebCrypto-based**, asymmetric only, with an explicit `alg` allow-list
  (RSA-PKCS1-v1_5, RSA-PSS, Ed25519, ECDSA). Mirror the `@dwk/dpop` hardening
  posture: no `none`, validate key sizes / curves, reject unexpected algorithms.
- **Plain-data inputs** — method, URL, headers, and the resolved key/body are
  passed in; the package returns a signing result or a verification result. It
  **MUST** unit-test **without a Workers runtime** (Node test environment, like
  the other reusables).
- **Protocol-agnostic:** key resolution (fetching an actor's public key, caching)
  is the caller's responsibility, supplied as a resolver.

## Testing

- Crafted signatures: happy path, tampered component, stale `created`/`expires`,
  wrong key, `Content-Digest` mismatch, and round-trip across both the RFC 9421
  and `draft-cavage` profiles.
