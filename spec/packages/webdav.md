# `@dwk/webdav`

| | |
|---|---|
| **Type** | endpoint (façade over the `solid-pod` Durable Object) |
| **Ships a DO?** | **no** — reuses the per-pod [`SolidPodObject`](solid-pod.md) (lock + write state live there) |
| **Standard** | [WebDAV (RFC 4918)](https://www.rfc-editor.org/rfc/rfc4918), Class 2 |
| **Status** | **in progress.** The protocol core, the Class 2 verb router (`createWebdav`), the lock + app-password DO-SQLite stores, the concrete `SolidPodObject` adapter + front door (`@dwk/solid-pod`'s `createSolidPodWebdav`), `COPY`/`MOVE` (resource + collection), **and the owner-gated app-password mint/list/revoke endpoint** (`createSolidPodWebdavCredentials`) are implemented, and `@dwk/store` now tracks per-resource byte size + mtime so `getcontentlength`/`getlastmodified` are real. The hosted litmus run is the remaining increment. Tracked in [#169](https://github.com/davidwkeith/workers/issues/169) |

> **This spec is authoritative and was reviewed before implementation.** The four
> load-bearing decisions below — the auth bridge and the compliance class
> especially — were agreed here first. The verb router enforces them over the
> injected `WebdavBackend` seam, which `@dwk/solid-pod` now resolves onto the live
> per-pod `SolidPodObject` (lock + app-password state in its SQLite, writes through
> the shared `@dwk/store` path).

A WebDAV (RFC 4918) façade over a pod, so the storage a user already owns can be
**mounted as a network drive by the file managers built into every major OS** —
macOS Finder, Windows Explorer, the GNOME/KDE managers, iOS Files — with zero
install and no app.

## Why this exists (and why it is not redundant with Solid)

[`@dwk/solid-pod`](solid-pod.md) is semantically richer (RDF, LDP, WAC, N3
Patch) but has **no turnkey end-user client on any platform**: the ecosystem is
developer SDKs and bespoke web apps, with nothing that mounts a pod in a native
file manager. WebDAV is old and dumb, but its **ubiquitous OS-level client
support** is something nothing else in the cohort offers. They are
**complementary, not competing**: Solid gives the pod *meaning*; WebDAV gives the
user a way to *touch their files* from hardware they already own. `@dwk/webdav`
is **one pod, a second door** — not a second store.

The verbs themselves are a thin translation over machinery that already exists:
[`@dwk/store`](store.md) streams R2 blob bodies (never buffered in the DO) and
does TOCTOU-free `If-Match` writes inside a single SQLite transaction, and
`solid-pod` already serves `GET/HEAD/PUT/POST/DELETE` on resources and containers
with ETag preconditions. The center of gravity is therefore **not** the verbs —
it is **auth** and **locking**.

## The four load-bearing decisions

### 1. Auth bridge — scoped **app passwords**, Basic-over-HTTPS, WAC still applies

Every OS WebDAV client speaks **Basic/Digest only** — none can present a
DPoP-bound token or run an IndieAuth / Solid-OIDC flow. This collides head-on
with the repo's **"DPoP everywhere"** non-functional rule, so it requires a
single, deliberate, scoped exception rather than a silent relaxation.

**Decision:**

- **App passwords.** A long (≥128-bit) random secret bound to
  `(WebID, label, scope, optional path-prefix, expiry)`. Presented as the
  password half of HTTP **Basic** (`Authorization: Basic …`).
- **The username is an opaque credential id, never the raw WebID.** Basic auth
  (RFC 7617) splits the decoded credential on the **first colon**, so a WebID URL
  (`https://…`) as the username would be truncated at `https` and break auth. The
  mint step therefore issues a colon-free credential id as the username; the
  server resolves it to the bound WebID. (The WebID is bound server-side, not
  carried on the wire.)
- **Hashed at rest.** Stored in the pod's DO SQLite **only as a salted hash**
  (PBKDF2-HMAC-SHA-256 via WebCrypto, high iteration count — Argon2 is not
  available in `workerd`). The plaintext is shown **once** at mint time and never
  persisted. This is why **Digest is *not* offered** — Digest needs a
  reversible/realm-keyed secret at rest, defeating hash-only storage, and forces
  MD5.
- **HTTPS-only.** Basic credentials are refused over anything but HTTPS (a
  `Strict-Transport-Security` header is set; a non-`https` request is rejected
  ahead of credential parsing).
- **Issuance is owner-gated and standalone — *not* `@dwk/indieauth`.** Minting,
  listing, and revoking app passwords is a **resource-server** concern (per-pod,
  revocable secrets), not OAuth client registration, so it does **not** reuse
  `@dwk/indieauth`'s issuance machinery. The mint/revoke endpoint is itself
  guarded by the pod's existing **DPoP-bound owner token** (`@dwk/dpop` edge
  validation) — you must already be the authenticated owner to create a WebDAV
  credential.
- **App-password scope is an *upper bound*, intersected with WAC.** A presented
  credential resolves to its WebID; the request is then evaluated by
  [`@dwk/wac`](wac.md) exactly as a Solid request would be. Effective access is
  `app-password scope ∩ WAC grants` — least privilege, so a read-only or
  path-restricted credential can never exceed the WebID's ACLs.
- **Brute-force resistance.** Per-credential failed-attempt throttling in the DO
  (authoritative, never KV); a constant-time hash compare.

### 2. Compliance class — **Class 2** (`DAV: 1, 2`), locks in DO SQLite

Class 1 (no locking) is Linux-friendly but mounts **read-only in macOS Finder**
and is flaky under the Windows WebClient. Read-write Finder/Windows mounts —
the entire point of this package — need **Class 2** (`LOCK`/`UNLOCK`).

**Decision: implement Class 2.**

- Advertise `DAV: 1, 2` on every `OPTIONS` response (Windows WebClient refuses to
  mount read-write without it) plus `MS-Author-Via: DAV`.
- **Exclusive write locks** only (the kind Finder/Windows take); **shared locks
  are deferred**. `Depth: 0` resource locks are the primary case (sufficient for
  Finder and Windows Explorer).
- **`Depth: infinity` collection locks are bounded, not open-ended.** An
  unrestricted infinity lock lets one credential lock an arbitrarily large
  subtree — locking `/` would freeze the whole pod. So infinity locks are
  **forbidden on the storage root** and rejected (`403`) above a configurable
  depth/subtree-size boundary; within the bound they are permitted for the
  collection-move case OS clients occasionally need.
- A lock is `(resource path, depth, owner href, lock token, WebID, expiry)`. The
  token is an unguessable `opaquelocktoken:<uuid>` URI. A default timeout with a
  hard cap; `LOCK` with no body **refreshes** an existing lock.
- **Expired locks are pruned opportunistically**, the same pattern as
  `solid-pod`'s `jti` replay table: every `LOCK`/`UNLOCK`/write transaction also
  drops rows whose `expiry` has passed (`DELETE … WHERE expiry < now`), so an
  abandoned lock never wedges a resource and the table cannot grow unbounded.
- **Lock state is net-new authoritative state → DO SQLite, never KV** (a lost or
  stale lock is a correctness bug). Because WebDAV locks the **same** resources
  Solid writes (see §3), the lock table MUST live in the **same per-pod DO** as
  the Solid write path — a separate DO could not see the pod's locks. This is the
  reason `@dwk/webdav` is a façade over `SolidPodObject`, not its own DO.
- **Enforcement is TOCTOU-free.** A write/MOVE/DELETE against a locked resource
  without the matching token in the `If:` header is rejected `423 Locked`; the
  lock check and the mutation happen in **one SQLite transaction**, reusing the
  pod's existing precondition path.

### 3. Resource model — **same pod, two protocols** (not a separate tree)

**Decision: WebDAV exposes the *same* resources `solid-pod` serves over
`@dwk/store`,** not a parallel file tree. This is the data-ownership win — the
files you reach in Finder *are* your pod.

- **Mapping:** WebDAV **collection** ⇔ LDP **container**; WebDAV non-collection
  ⇔ LDP **resource** (RDF or blob). `MKCOL` creates a container; `PUT` of a
  `text/turtle` body parses into the quad store and a binary body routes to the
  R2 blob tier — **the exact size-routing and parse path `solid-pod` already
  uses on `PUT`** (so an `.ttl` written from Finder is a first-class Solid
  resource, and a JPEG is a streamed R2 blob).
- **Content-type inference for OS clients.** Finder/Explorer routinely `PUT`
  files with a generic `application/octet-stream`/`text/plain` or no
  `Content-Type` at all — which would store a `.ttl` as an opaque blob instead of
  parsing it into the quad store. So when the request type is missing or generic,
  the façade **infers from the file extension** (`.ttl` → `text/turtle`, `.jsonld`
  → `application/ld+json`, etc.) before handing off to the pod's `PUT` path; an
  explicit, specific client `Content-Type` always wins.
- **ETags / preconditions** reuse `@dwk/store`'s per-resource opaque validators
  and TOCTOU-free `If-Match`; WebDAV's `If:` header (`[etag]` and
  `<locktoken>` productions) maps onto them.
- **`COPY` / `MOVE`** are store-level pointer operations: `COPY` writes a new
  pointer to the **same content-addressed R2 key** (dedup makes it nearly free);
  `MOVE` is copy-then-drop-pointer in one transaction. Collection `COPY`/`MOVE`
  honor `Depth`.
- **Auxiliary resources are fully inaccessible over WebDAV.** `.acl` / `.meta`
  are Solid control-plane, not files: every WebDAV verb against them (and they are
  likewise omitted from `PROPFIND` listings) returns **`404 Not Found`** — not
  just hidden-from-listing or read-only. Surfacing an ACL as a readable/movable
  file risks leaking or corrupting access control; WAC remains the only way to
  change permissions, and it still governs everything underneath.
- **OS litter** (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) is accepted as
  ordinary blob resources by default — silently dropping a `PUT` that returns
  `201` confuses clients. An **optional** configurable denylist MAY refuse or
  hide a litter set, off by default.

### 4. XML footprint — hand-rolled, bounded, XXE-safe

A general-purpose XML library would blow the script-size budget (3 MB free /
10 MB paid), matching the same hand-rolled discipline as the iCalendar emitter
and the N3 Patch parser.

**Decision: hand-roll a minimal generator + a bounded parser.**

- **Generate** `<D:multistatus>` / `<D:prop>` / `<D:lockdiscovery>` by string
  templating with strict XML escaping.
- **Parse** only the small, known request bodies — `propfind`
  (`allprop`/`propname`/`prop`), `lockinfo`, and `propertyupdate` (PROPPATCH) —
  with **DoS bounds**: caps on body size and element nesting, rejecting anything
  over the bound `400` (cf. the bounded N3 `solid:where` solver).
- **XXE guard:** a `DOCTYPE` / external-entity declaration is **rejected
  outright** — no entity resolution, ever.
- **UTF-8 only.** The hand-rolled parser assumes UTF-8; a request declaring any
  other charset (in `Content-Type` or via a non-UTF-8 BOM / XML encoding
  declaration) is rejected `415`, closing the encoding-bypass class (UTF-16/UTF-7
  smuggling past the bounds/XXE checks) that a hand-rolled parser is prone to.
- **The `If:` header is parsed as a strict, documented subset.** RFC 4918 §10.4's
  full grammar (tagged + untagged lists, multiple state tokens, `Not`) is a
  classic source of parser-differential bugs. The server supports only what the
  precondition path needs — a single untagged list of one lock token and/or one
  ETag — and answers a more complex `If:` with `400`/`501` rather than
  best-effort guessing.
- **Live properties** supported: `displayname`, `getcontentlength`,
  `getcontenttype`, `getlastmodified`, `getetag`, `resourcetype`,
  `lockdiscovery`, `supportedlock`, `creationdate`.
- **PROPPATCH** of arbitrary **dead properties** is **out of scope for v1** (no
  general dead-property store — that is net-new state for little OS-client gain);
  a small set of known client-written props (e.g. Win32 attributes/timestamps)
  is **accepted-and-ignored** (`200`, not persisted) so Finder/Explorer do not
  error.

## Verb surface

`OPTIONS`, `PROPFIND` (`Depth: 0`/`1`; `infinity` guarded or `403`),
`PROPPATCH` (live/known-only per §4), `MKCOL`, `GET`, `HEAD`, `PUT`, `DELETE`,
`COPY`, `MOVE`, `LOCK`, `UNLOCK`. Successful responses and `OPTIONS` advertise an
accurate `Allow`; the storage root is undeletable (inherited from
`solid-pod`'s `#server-delete-protect-root-container`).

## OS-client quirks to design around

- **macOS Finder (WebDAVFS):** needs Class 2 for read-write; issues heavy
  `PROPFIND Depth: 1` (served efficiently via the store's `list(prefix)`
  projection); writes `.DS_Store` / `._*`.
- **Windows WebClient:** insists on `DAV: 1, 2` in `OPTIONS`; ~50 MB default
  upload cap (client-side registry tweak — **documented, not server-fixable**);
  picky about auth and requires HTTPS.
- **Linux `davfs2` / gvfs:** tolerant; Class 1 would suffice but Class 2 is fine.

## Composition & bindings

Standard endpoint shape per
[composition-contract.md](../composition-contract.md): a
`createWebdav(config): (request, env, ctx) => Promise<Response>` factory,
mountable under a path prefix, declaring its Cloudflare bindings as an `Env`
fragment, **failing loudly when a required binding is missing**, reading **no**
global environment.

- **Recommended composition:** the front door is **stateless** and translates
  WebDAV verbs into the **same `SolidPodObject` per-pod DO**'s storage/lock
  operations — one consistency domain shared with Solid writes, WAC, and ETags.
  `@dwk/webdav` therefore composes *with* `@dwk/solid-pod` rather than
  instantiating its own DO.
- **Standalone fallback:** a WebDAV-only deployment (no Solid surface) MAY run a
  thin DO that instantiates `@dwk/store` directly — but it then has no WAC/Solid
  resources to share, so this is the lesser, documented option.

### Bindings (declared `Env` fragment)

- The per-pod **Durable Object namespace** (`SolidPodObject`) it fronts.
- The **R2 bucket** for blob bodies (the pod's bucket).
- App-password hashing parameters / pepper secret.

### Config

- `baseUrl` and the mount path prefix.
- App-password policy: KDF iterations, default + max expiry, scope vocabulary.
- Lock policy: default + max lock timeout.
- Optional OS-litter denylist (off by default).

## Design constraints

- **Authoritative state — locks and app-password hashes — in DO SQLite only,
  never KV** (see [non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- **Stream R2 bodies** — never buffer a full blob in the DO.
- **No general XML library**; hand-rolled, bounded, XXE-safe (§4).
- **WAC is never bypassed** — Basic auth resolves to a WebID and the request is
  authorized exactly like a Solid request; app-password scope only *narrows*.

## Security summary

App passwords hashed at rest (PBKDF2-HMAC-SHA-256) and shown once, keyed by a
colon-free opaque credential id; HTTPS-only; constant-time compare with
per-credential throttling; unguessable lock tokens with bounded `Depth: infinity`
and opportunistic expiry pruning; auxiliary resources (`.acl`/`.meta`) `404` to
all verbs; UTF-8-only, `DOCTYPE`/external-entity-rejecting XML and a strict-subset
`If:` parser; scope ∩ WAC least privilege.

## Conformance / testing

- The **[litmus](http://www.webdav.org/neon/litmus/)** WebDAV test suite
  (basic / copymove / props / locks) against a deployed target, plus real
  **Finder / Windows Explorer / davfs2** read-write mounts.
- `workerd`-environment unit/integration tests per the repo test split: verb
  translation, the bounded XML parser, lock acquisition/refresh/conflict
  (`423`), `COPY`/`MOVE` semantics, and app-password issuance/scope/WAC
  intersection.
- Add a `@dwk/webdav` row to `conformance/status.json` **when implementation
  begins** (it is intentionally absent while this is spec-only, so the release
  gate is unaffected). See
  [conformance-and-testing.md](../conformance-and-testing.md).

## Explicitly out of scope (v1)

- **CalDAV (RFC 4791) / CardDAV** and scheduling (iTIP/iMIP/RFC 6638) — see the
  calendar tracking issue [#167](https://github.com/davidwkeith/workers/issues/167);
  WebDAV here is plain file access, not calendar collections.
- **Shared locks**, **Digest** auth, a general **dead-property** store, **quota**
  (`{DAV:}quota-*`) reporting, and **DeltaV** versioning.
- **Per-member `207 Multi-Status` failure reporting** for collection
  `DELETE`/`COPY`/`MOVE` (RFC 4918 §9.6.1). A collection operation that fails
  collapses to a single representative status (e.g. `423`/`409`) rather than
  enumerating each blocked member; sufficient for the OS-client target, revisited
  only if the litmus `copymove`/`locks` suites require it.

See [open-questions.md](../open-questions.md).
