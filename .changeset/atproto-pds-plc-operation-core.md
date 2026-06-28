---
"@dwk/atproto-pds": minor
---

Add the **`did:plc` operation core** (`plc.ts`) — increment 1 of #182, the second
Cirrus-parity gap (#180).

Most real Bluesky accounts are PLC-rooted, so hosting or migrating one in requires
speaking `did:plc`. This change lands the pure, Workers-runtime-free core that
builds, signs, and identifies PLC operations using only the existing DAG-CBOR /
SHA-256 / base32 / curve primitives (did:plc spec v0.1 wire format):

- `signPlcOperation` / `unsignedPlcBytes` / `signedPlcBytes` — sign a genesis or
  rotation operation over its DAG-CBOR-without-`sig` encoding; the signature is
  the low-S 64-byte `r‖s` (secp256k1 or P-256 rotation key) base64url-encoded
  without padding.
- `didPlcFromGenesis` — derive `did:plc:` + the first 24 base32 chars of
  `SHA-256(signed genesis op)`.
- `plcOperationCid` — the CID string of a signed op, used as the next op's `prev`.
- `verifyPlcOperation` — verify an op's signature against a rotation key.
- New `base64urlEncode` / `base64urlDecode` byte helpers.

`did:web` remains the default. The Durable Object wiring and the injectable PLC
**directory client** (submission/resolution) land in increment 2; `did:plc`
necessarily depends on the external PLC directory, a trade-off accepted only to
interoperate with the existing network and never made the default.
