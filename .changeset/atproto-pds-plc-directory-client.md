---
"@dwk/atproto-pds": minor
---

Add the **PLC directory client** — increment 3 of #182, completing `did:plc`
support (registration + resolution).

- **New `plc-directory.ts`** with an injectable `fetch`: `submitPlcOperation`
  (`POST /:did` — register a genesis op or append a rotation), `resolvePlcDid`
  (`GET /:did` — resolve a DID document, `null` on 404), and `fetchPlcData`
  (`GET /:did/data` — the current rotation keys / verification methods / services
  an inbound migration reads). Errors surface the directory's status and body.
- **New `plcDirectoryUrl` config.** When set and `didMethod` is `"plc"`, the DO
  submits its freshly minted genesis operation to the directory at creation — in
  the background via `ctx.waitUntil`, so repo init (and the first request) never
  blocks on the external call — best-effort and one-shot. It **defaults to unset**
  — the account is locally self-consistent and nothing reaches the network unless
  asked, which also keeps tests hermetic.
- Exported from the package surface; the resolve/data helpers are what account
  migration (#183) will use to read a foreign account's keys and services.

The external PLC directory remains opt-in and never the default path.
