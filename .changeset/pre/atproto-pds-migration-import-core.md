---
"@dwk/atproto-pds": minor
---

Add the inbound-migration **CAR import core** (`migrate.ts`) — increment 1 of
#183, the last Cirrus-parity gap, now unblocked by k-256 (#181) and did:plc
(#182).

The standard migration flow exports the source repository as a CAR
(`com.atproto.sync.getRepo` on the old PDS) and imports it onto the new one. This
change lands the pure, Workers-runtime-free core that turns those CAR bytes back
into a verified repository:

- **`importRepoFromCar(carBytes, { verifyKey? })`** — parses the CAR, decodes the
  root commit, optionally **verifies its signature** against the source account's
  repository key (a mismatch throws), then walks the MST to recover every
  `collection/rkey → record` entry from the same block bag. Returns the DID, rev,
  signed commit, head CID, and the flat record set. Throws on a missing root,
  missing block, or unsupported commit version.

The repository is self-verifying, so an import can trust the export end-to-end
before writing anything. Wiring this into the Durable Object (the `importRepo`
XRPC + `createAccount`-with-existing-DID), importing referenced blobs, the
activate/deactivate cutover, and PLC rotation are the following increments.
