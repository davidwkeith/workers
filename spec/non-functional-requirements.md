# Non-functional requirements

## Consistency rules (load-bearing)

- Authoritative state MUST live only in **strongly-consistent** stores:
  **Durable Object SQLite**, **R2**, or **D1 accessed with session
  consistency** (read-your-writes). D1's default cross-replica reads are
  *eventually* consistent and MUST NOT be relied on for authoritative state.
- **KV MUST NEVER be used for authz, or for anything where staleness is a
  correctness or security bug** (KV propagation is ≈60 s eventually
  consistent). KV is acceptable only for data that tolerates staleness (e.g.
  caches that are safe to be wrong/stale).

See Cloudflare's [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency)
documentation for the guarantees these rules rely on.

## Runtime budget

Stay within Cloudflare Worker
[platform limits](https://developers.cloudflare.com/workers/platform/limits) and
[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits):

| Limit | Value |
|---|---|
| Memory | 128 MB (hard) |
| CPU time | 30 s (paid) |
| Script size | 3 MB (free) / 10 MB (paid) |
| Startup time | 1 s |

Implications:

- **Stream R2 bodies through the Worker** — never buffer a full blob in the
  Durable Object.
- Prefer **N3.js** for RDF. Do **not** ship Comunica or jsonld.js if doing so
  blows the script-size budget.
- A single DO SQLite cell is bounded (~2 MB); RDF over that ceiling is treated
  as an opaque body and offloaded to R2 (see
  [packages/solid-pod.md](packages/solid-pod.md) and
  [packages/store.md](packages/store.md)).

## Security

- **DPoP everywhere** tokens are used.
- **No ACL / decision caching outside strongly-consistent layers.**
- **Least-privilege bindings** — a package gets only the bindings it declares.
- **Outbound SSRF posture is deny-by-default** — every fetch of an attacker-
  or user-supplied URL goes through [`@dwk/safe-fetch`](packages/safe-fetch.md),
  which blocks private/reserved hosts. The only exception is an **explicit,
  composer-injected local-dev allowlist** (`allowedHosts`, exposed by consuming
  packages as `fetchAllowedHosts`): exact `host[:port]` entries, never read
  from the environment, and audited via the `safe_fetch.ssrf.allowed_host`
  log/metric event whenever it is actually used.

## Observability

- Packages MUST expose an **injectable** logging seam (the `Logger` interface
  from [`@dwk/log`](../packages/log)) via their config/options, defaulting to a
  **no-op** — logging is opt-in and packages MUST NOT reach for a global logger
  or read the environment for one.
- Logs MUST be **structured events** (a stable dotted event name + structured
  fields), not free text, so they are queryable. Security-relevant events (a
  blocked SSRF attempt, auth/authz rejections, validation rejections) MUST be
  first-class and MUST NOT be silently swallowed.
- **Redaction:** tokens, credentials, and full request/response bodies MUST NOT
  be logged; URLs are logged as host-only.
- See [observability.md](observability.md) for the full requirement, the
  severity guide, and the event-taxonomy convention.

## Distribution

- **Independent semver per package.**
- **ESM**, fully typed.
- Documented bindings + config per package.
- **Changesets** for release management.

## Licensing

**ISC** — permissive, OSI-approved, npm's default. Chosen to match the
maximally-permissive, democratization goal of the project.
