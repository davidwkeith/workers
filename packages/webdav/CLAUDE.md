# @dwk/webdav

WebDAV (RFC 4918, Class 2) façade over a Solid pod — mount your storage as a
native network drive.

## What this is

Translates the WebDAV verbs OS file managers speak (macOS Finder, Windows
Explorer, GNOME/KDE, iOS Files) onto the same resources `@dwk/solid-pod` serves
— one pod, a second door, not a second store. Ships the pure protocol core
(XXE-safe bounded XML, scoped app passwords, strict-subset `If:` header
parsing, content-type inference, OS-litter matching), the Class 2 verb router
(`createWebdav`) driven over an injected `WebdavBackend` seam, and the lock +
app-password DO-SQLite stores (`LockStore`, `CredentialStore`). **Status: in
progress** — `@dwk/solid-pod` resolves the backend seam onto the live per-pod
`SolidPodObject` (`createSolidPodWebdav`), but the hosted litmus run is the
remaining increment.

## Spec

`spec/packages/webdav.md` — authoritative requirements (reviewed before
implementation; the four load-bearing decisions live there).

## Key constraints

- **No DO of its own.** WebDAV locks the same resources Solid writes, so lock
  and app-password state MUST live in the same per-pod DO as the Solid write
  path — this package is a façade over `SolidPodObject`, never a second DO.
  The concrete adapter is supplied by the composing Worker (`@dwk/solid-pod`);
  the injectable `WebdavBackend` seam is what lets the router unit-test
  without the whole pod DO.
- **Auth bridge is the one scoped DPoP exception.** OS clients speak Basic
  only, so scoped app passwords over HTTPS: colon-free opaque credential id as
  the username (never the raw WebID), secret hashed at rest with
  PBKDF2-HMAC-SHA-256 (plaintext shown once), constant-time compare,
  per-credential throttling. No Digest. Effective access is
  `app-password scope ∩ WAC` — WAC is never bypassed.
- **Class 2 locking, DO SQLite only.** Exclusive write locks (shared
  deferred); `Depth: infinity` bounded and forbidden on the storage root;
  `opaquelocktoken:<uuid>` tokens; expired locks pruned opportunistically.
  Lock enforcement is TOCTOU-free — check and mutation in one transaction.
  Never KV.
- **Hand-rolled, bounded, XXE-safe XML.** No general XML library
  (script-size budget). `DOCTYPE`/markup declarations rejected outright;
  body-size and nesting caps; UTF-8 only. The `If:` header is a strict subset
  (one untagged list, one lock token and/or one ETag) — anything more is
  refused, not guessed.
- **Same pod, two protocols.** Collection ⇔ LDP container; `PUT` reuses the
  pod's size-routing/parse path (a `.ttl` from Finder is a first-class Solid
  resource). Generic/missing `Content-Type` is inferred from the extension;
  an explicit specific type wins. `.acl`/`.meta` are `404` to every verb and
  omitted from listings.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- Main: `src/test-harness.ts` (test-only `WebdavTestObject` DO)
- DO: `WEBDAV_DO` → `WebdavTestObject`, `useSQLite: true` — the stores and
  router run against real DO SQLite, not an in-memory fake

```bash
pnpm test --project @dwk/webdav
```

## File layout

```
src/index.ts            # public surface: protocol core + createWebdav + stores
src/config.ts           # WebdavConfig, Env fragment, WebdavBackend seam
src/webdav.ts           # createWebdav — the Class 2 verb router
src/xml.ts              # bounded XXE-safe XML generator + parser
src/if-header.ts        # strict-subset If: precondition parser
src/credentials.ts      # app-password mint/verify crypto (pure, WebCrypto)
src/credential-store.ts # CredentialStore — hash-at-rest + throttling, DO SQLite
src/locks.ts            # LockStore — exclusive locks + pruning, DO SQLite
src/content-type.ts     # extension-based Content-Type inference for OS clients
src/litter.ts           # OS-litter matcher (.DS_Store etc.), off by default
src/test-harness.ts     # test-only SQLite-backed DO (excluded from publish)
src/*.test.ts           # colocated tests
```

## Dependencies

None (runtime). Pure protocol core plus DO-SQLite stores over the workerd
built-in `SqlStorage`; the concrete pod adapter lives in `@dwk/solid-pod`,
which depends on this package — never the reverse.
