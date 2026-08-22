---
"@dwk/atproto-pds": minor
---

Wire account migration into the PDS — increment 2 of #183: the
`com.atproto.repo.importRepo` handler that imports a real source repository.

- **`com.atproto.repo.importRepo`** — an authenticated import that resolves the
  source account's signing key from its DID document, **verifies** the uploaded
  CAR's root commit against it, replaces the record set with the imported records
  (stored verbatim so their CIDs are preserved), and **re-signs a fresh head**
  commit with this PDS's key, chaining `prev` to the imported head (the agreed
  "re-sign on top" model). The current-state store keeps the imported records; the
  source's deeper commit history is not retained.
- **`resolve.ts`** — `resolveDidDocument` / `resolveSigningKey`: fetch an
  account's DID document (the PLC directory for `did:plc`, the origin's
  `/.well-known/did.json` for `did:web`) and recover its repository signing key.
  `fetch` is injected for testing.
- **`decodeMultikey`** (in `crypto.ts`) — the inverse of `publicKeyMultibase`:
  decode a `z…` Multikey back to a raw public key + curve (both P-256 and
  secp256k1), reading the multicodec prefix and decompressing the SEC1 point.

The remaining migration pieces follow in later increments: blob import, the
`activate`/`deactivate` cutover with account-status reporting, and PLC key
rotation.
