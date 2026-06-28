---
"@dwk/webdav": minor
---

Implement the **`createWebdav` Class 2 verb router** and the authoritative
DO-SQLite state it drives, building on the protocol core (#169).

- **`createWebdav(config)`** — the RFC 4918 Class 2 request handler:
  `OPTIONS` (advertising `DAV: 1, 2` + `MS-Author-Via`), `PROPFIND`
  (`Depth: 0`/`1`, `infinity` refused), `PROPPATCH` (live/known-only),
  `MKCOL`, `GET`/`HEAD`, `PUT`, `DELETE`, `COPY`/`MOVE`, `LOCK`/`UNLOCK`. It
  generates the `multistatus`/`lockdiscovery` XML, infers content types and
  applies the optional OS-litter denylist, and renders backend errors as the
  right status (`412`/`409`/`423`).
- **Auth bridge (§1)** — HTTPS-only HTTP Basic resolving an app password to a
  WebID, with `scope ∩ WAC` least privilege: the credential's scope is an upper
  bound, then the request is authorized exactly as a Solid request would be.
- **`LockStore` (§2)** — exclusive write locks in DO SQLite:
  `opaquelocktoken:<uuid>` tokens, `Depth: 0` resource and **bounded**
  `Depth: infinity` collection locks (forbidden on the storage root and above a
  configurable depth), refresh/unlock, and opportunistic expiry pruning. A
  mutation of a locked resource without the matching `If:` token is `423 Locked`.
- **`CredentialStore` (§1)** — app-password persistence (hash-only) with
  per-credential failed-attempt throttling and constant-time verification.
- **`.acl`/`.meta` are `404` to every verb** and omitted from listings (§3).

The protocol logic runs over an injected **`WebdavBackend`** seam (the explicit
Durable Object boundary), so the router unit-tests at full DO-SQLite fidelity
without standing up the whole pod. The concrete `SolidPodObject` adapter that
resolves that seam onto the per-pod DO is the remaining increment.
