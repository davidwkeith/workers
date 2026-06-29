---
"@dwk/atproto-pds": minor
---

Add `com.atproto.identity.updateHandle` and emit a firehose `#identity` event.

The account handle was fixed at config. `updateHandle` (owner-authenticated) now
changes it: the new handle is persisted as an override and an **`#identity`**
event (`{ seq, did, time, handle }`) is broadcast on the firehose — sharing the
single `seq` space and `?cursor=` backfill ring with `#commit`/`#account` — so a
subscribed Relay re-resolves the handle ⇄ DID binding without polling. The
effective handle (override, else configured) now flows through every surface that
reports it: `createSession`/`getSession`/`refreshSession`, `resolveHandle`,
`describeRepo`, the `did:web` DID document `alsoKnownAs`, and
`getRecommendedDidCredentials`. The change is serialized through the write chain
and emits only on an actual handle change. Adds `encodeIdentityFrame` to the
frame encoder.

The PDS records the claimed handle; bidirectional verification (the new handle
resolving back to this DID via DNS `_atproto` or `/.well-known/atproto-did`)
remains the network's job, as in the reference PDS.
