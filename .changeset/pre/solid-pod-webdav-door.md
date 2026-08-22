---
"@dwk/solid-pod": minor
---

Wire the `@dwk/webdav` Class 2 façade onto the live per-pod `SolidPodObject` —
the "second door" (#169). The pod's storage is now mountable as a network drive
by OS file managers over HTTP Basic app-passwords, sharing one consistency
domain with the Solid door.

- **`createSolidPodWebdav(config)`** — a stateless WebDAV front door that
  resolves the per-pod DO and forwards verbs (with an `x-solid-webdav` marker
  and the raw `Authorization` header) to it.
- **In-DO integration** — `SolidPodObject` now hosts the `LockStore` and
  `CredentialStore` in its own SQLite and runs the `createWebdav` router over an
  in-DO `WebdavBackend` adapter built on the pod's `@dwk/store` + WAC. App
  passwords are verified in the DO; effective access is `scope ∩ WAC`. PUT/MKCOL
  reuse the exact RDF-vs-blob routing and `ldp:contains` containment as Solid
  writes (a `.ttl` written from Finder is a first-class quad resource), and the
  storage root stays undeletable. Lock state lives beside the Solid write path,
  so a WebDAV `LOCK` blocks an unkeyed Solid or WebDAV write alike (`423`).
- The shared write path is refactored into a request-independent
  `#writeResolvedBody` so both doors classify and store bodies identically.

`COPY`/`MOVE` (currently `501`), the owner-gated app-password mint/revoke
endpoint, and the hosted litmus run land in a follow-up increment.
