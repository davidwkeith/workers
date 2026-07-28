# @dwk/webdav

A **WebDAV (RFC 4918, Class 2)** façade over a [Solid pod](../solid-pod), so the
storage a user already owns can be **mounted as a network drive by the file
managers built into every major OS** — macOS Finder, Windows Explorer, the
GNOME/KDE managers, iOS Files — with zero install and no app.

It is **one pod, a second door**: WebDAV exposes the _same_ resources
`@dwk/solid-pod` serves, not a parallel tree, so the files you reach in Finder
_are_ your pod. Solid gives the pod meaning (RDF, LDP, WAC, N3 Patch); WebDAV
gives the user a way to touch their files from hardware they already own.

> **Status: in progress.** This package implements
> [`spec/packages/webdav.md`](../../spec/packages/webdav.md) end to end: the
> protocol core, the Class 2 verb router (`createWebdav`) with locking and
> `COPY`/`MOVE`, and the lock + app-password DO-SQLite stores. The concrete
> backend adapter that resolves the `WebdavBackend` seam onto the per-pod
> Durable Object ships as `createSolidPodWebdav` in
> [`@dwk/solid-pod`](../solid-pod), alongside the owner-gated
> `createSolidPodWebdavCredentials` mint/list/revoke endpoint. What's left is
> conformance: a hosted litmus run found and fixed several RFC 4918 bugs but is
> still failing on one percent-encoding edge case pending re-verification — see
> [`conformance/webdav-qa.md`](../../conformance/webdav-qa.md). See the spec
> for the four load-bearing decisions.

## What's implemented today

### Class 2 verb router

- **`createWebdav(config)`** — the RFC 4918 Class 2 request handler:
  `OPTIONS` (advertising `DAV: 1, 2`), `PROPFIND` (`Depth: 0`/`1`),
  `PROPPATCH` (live/known-only), `MKCOL`, `GET`/`HEAD`, `PUT`, `DELETE`,
  `COPY`/`MOVE`, and `LOCK`/`UNLOCK`. It generates the `multistatus` /
  `lockdiscovery` XML, infers content types, applies the optional OS-litter
  denylist, and maps backend errors to `412`/`409`/`423`. Auxiliary `.acl` /
  `.meta` resources are `404` to every verb and omitted from listings. (spec §3)
- **Auth bridge** — HTTPS-only HTTP Basic resolving an app password to a WebID,
  with `scope ∩ WAC` least privilege. (spec §1)

### Authoritative DO-SQLite state

- **`LockStore`** — exclusive write locks in DO SQLite: `opaquelocktoken:<uuid>`
  tokens, `Depth: 0` resource and **bounded** `Depth: infinity` collection locks
  (forbidden on the storage root and above a configurable depth),
  refresh/unlock, and opportunistic expiry pruning. (spec §2)
- **`CredentialStore`** — app-password persistence (hash-only) with
  per-credential failed-attempt throttling and constant-time verification.
  (spec §1)

The router runs over an injected **`WebdavBackend`** seam (the explicit Durable
Object boundary), so it unit-tests at full DO-SQLite fidelity without standing up
the whole pod. [`@dwk/solid-pod`](../solid-pod) resolves that seam onto the live
per-pod `SolidPodObject` (`createSolidPodWebdav` for the data door,
`createSolidPodWebdavCredentials` for app-password management), so both stores
run inside the same DO as the Solid write path.

### Protocol core

All pure, Workers-runtime-free, and unit-tested:

- **Bounded, XXE-safe XML** (`parseXml`, `escapeXml`) — a hand-rolled generator
  and recursive-descent parser for the small WebDAV bodies, with caps on size
  and nesting depth, `DOCTYPE`/external-entity rejection, UTF-8-only enforcement,
  and predefined-entity-only decoding. (spec §4)
- **Scoped app passwords** (`mintAppPassword`, `verifyAppPassword`) — the auth
  bridge for OS clients that speak Basic only: a ≥128-bit secret bound to
  `(WebID, label, scope, expiry)`, presented under a colon-free credential id,
  stored only as a salted PBKDF2-HMAC-SHA-256 hash, verified in constant time.
  (spec §1)
- **Strict `If:` parser** (`parseIfHeader`) — a documented subset (one untagged
  list of one lock token and/or one ETag); anything more complex is reported
  `unsupported`. (spec §4)
- **OS-client quirks** (`inferContentType`, `isOsLitter`) — extension-based
  content-type inference for generic `PUT`s, and OS-litter detection. (spec §3)

## License

ISC
