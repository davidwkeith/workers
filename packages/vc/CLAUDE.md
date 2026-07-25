# @dwk/vc

Verifiable Credentials (VCDM 2.0) + did:web + revocation endpoint.

## What this is

Issues and verifies W3C Verifiable Credentials with Data Integrity proofs.
Implements `did:web` resolution (static DID documents served at
`/.well-known/did.json`), credential issuance with Ed25519/ECDSA signatures,
verification with proof validation, and optional Bitstring Status List
revocation via D1. Includes JCS (JSON Canonicalization Scheme), multibase/
multicodec encoding, and XSD datetime utilities.

## Spec

`spec/packages/vc.md` — authoritative requirements.

## Key constraints

- **Static DID document.** The `did:web` document is Anglesite-generated; this
  package serves it but does not dynamically manage verification methods.
- **Data Integrity proofs.** Credentials are secured with Data Integrity
  `DataIntegrityProof` using supported cryptosuites (Ed25519, ECDSA). No JWS
  or JWT credential format.
- **Signing key binding.** `VC_SIGNING_KEY` secret must be bound. Fail loudly
  at startup if missing.
- **Revocation via Bitstring Status List.** Optional — when configured, each
  credential gets a `credentialStatus` entry pointing to a status list
  credential. Revocation flips a bit in the D1-backed status store.
- **Authorization.** The `authorize` callback in config controls who can issue/
  verify/revoke. This is caller-provided, not hardcoded.
