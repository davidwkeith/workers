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
app-password DO-SQLite stores (`LockStore`, `CredentialStore`). `@dwk/solid-pod`
resolves the backend seam onto the live per-pod `SolidPodObject`
(`createSolidPodWebdav` for data, `createSolidPodWebdavCredentials` for
app-password management). **Status: in progress** — implementation is done;
a 2026-07-29 local full-group litmus run (issue #467) passes `basic` 16/16,
`copymove` 13/13, and `locks` 41/41; `props` fails 8/30 cases, all on
dead-property storage (excluded from v1 by spec §4 — the remaining blocker).
The hosted re-run against `conformance.dwk.io` is pending fresh credentials —
see `conformance/webdav-qa.md`.

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
- **Class 2 locking, DO SQLite only.** Exclusive and shared write locks
  (shared: any number coexist, any one token admits a write, exclusive
  conflicts with everything — litmus `lock_shared`/`double_sharedlock`);
  `Depth: infinity` bounded and forbidden on the storage root;
  `opaquelocktoken:<uuid>` tokens; expired locks pruned opportunistically.
  Lock enforcement is TOCTOU-free — check and mutation in one transaction.
  Never KV.
- **Hand-rolled, bounded, XXE-safe XML.** No general XML library
  (script-size budget). `DOCTYPE`/markup declarations rejected outright;
  body-size and nesting caps; UTF-8 only. The `If:` header is parsed as the
  full RFC 4918 §10.4 grammar under hard DoS bounds (capped lists and
  conditions; tagged + untagged lists, `Not`, `DAV:no-lock`) and genuinely
  evaluated — `412` when no list holds — with anything outside the bounded
  grammar refused `400`, not guessed.
- **Same pod, two protocols.** Collection ⇔ LDP container; `PUT` reuses the
  pod's size-routing/parse path (a `.ttl` from Finder is a first-class Solid
  resource). Generic/missing `Content-Type` is inferred from the extension;
  an explicit specific type wins. `.acl`/`.meta` are `404` to every verb and
  omitted from listings.
