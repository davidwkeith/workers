---
"@dwk/atproto-pds": minor
---

Add the account-status cutover endpoints — part of #183 (account migration).

Migration coordinates a clean hand-off so the network has exactly one live home:
the old PDS is deactivated and the new one activated. This adds that switch:

- **`com.atproto.server.activateAccount` / `deactivateAccount`** — authenticated
  toggles of the account's active state (persisted in the repository DO).
- **`com.atproto.sync.getRepoStatus`** — public status a Relay polls to decide
  whether to crawl this PDS: `{ did, active, status?, rev }` (`status: "deactivated"`
  when inactive).
- **`com.atproto.server.checkAccountStatus`** — the owner's view: activation
  state, repo head/rev, and indexed-record count.
- `com.atproto.sync.listRepos` now reports each repo's `active` flag.

Accounts are active by default. Blob import and PLC key rotation are the
remaining migration increments.
