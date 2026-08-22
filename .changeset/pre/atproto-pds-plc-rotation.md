---
"@dwk/atproto-pds": minor
---

Add PLC key-rotation building blocks — the last migration piece of #183.

Re-pointing a `did:plc` at the new PDS requires a rotation operation signed with
a key the account controls. The PDS never holds a migrated account's rotation
key, so it **recommends** the credentials and provides the op constructor; the
migrating client signs and submits:

- **`com.atproto.identity.getRecommendedDidCredentials`** (authenticated) —
  recommends the DID credentials that point the account at this PDS: our signing
  key (`verificationMethods.atproto`), our endpoint (`services.atproto_pds`), the
  account handle (`alsoKnownAs`), and — for a `did:plc` this PDS minted — its
  rotation key.
- **`buildRotationOperation`** (in `plc.ts`) — build the next PLC operation from
  the previous one, applying field updates and chaining `prev` to its CID, ready
  to sign with a current rotation key (via `signPlcOperation`) and submit with the
  directory client.

This completes the account-migration surface (#183); the firehose (#184) is the
remaining Cirrus-parity gap.
