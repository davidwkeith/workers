---
"@dwk/atproto-pds": minor
---

Wire `did:plc` into the PDS — increment 2 of #182. A fresh `did:plc` account now
works end to end within the PDS (directory submission is the remaining piece).

- **New `didMethod: "web" | "plc"` config** (defaults to `"web"`). `"web"` is
  unchanged. `"plc"` mints a `did:plc` account at genesis.
- **DO genesis for `did:plc`** — the Durable Object generates a **DO-custodied
  secp256k1 rotation key** (generated inside, never emitted, like the signing
  key), self-signs a genesis operation, derives the account's `did:plc`, and
  persists both. An existing `did:plc` can be adopted by passing `did` (for
  migration). The account DID now flows through the derived value everywhere
  (commits, sessions, `at://` URIs, blob keys, describe/list), not the config DID.
- **Front door routing** now keys the per-account DO by a stable host key rather
  than the DID (a fresh `did:plc` isn't known until genesis). For `did:plc`
  accounts, `/.well-known/atproto-did` is served from the DO and
  `/.well-known/did.json` returns 404 (a PLC account's document lives in the
  directory). `did:web` behaviour is unchanged.
- A `config.did` that disagrees with `didMethod` is now rejected at startup.

The injectable PLC **directory client** (submitting the genesis operation and
resolving foreign DIDs — also needed by migration #183) lands in the next
increment. The external PLC directory remains opt-in and never the default.
