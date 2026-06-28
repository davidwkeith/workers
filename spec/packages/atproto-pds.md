# `@dwk/atproto-pds`

| | |
|---|---|
| **Type** | endpoint + Durable Object |
| **Ships a DO?** | **yes** — a per-account repository Durable Object |
| **Standard** | [AT Protocol](https://atproto.com/specs/atp) (Bluesky) — Personal Data Server |
| **Status** | **implemented (beta), unreleased** — strategically still an honorable mention; scaffolded in answer to "there are no instances in atproto" — tracked in [#106](https://github.com/davidwkeith/workers/issues/106) |

An AT Protocol **Personal Data Server (PDS)**: the self-hosted home of a user's
repository in the Bluesky network, rooted at the user's own domain. It belongs
in the "self-owned web presence" thesis by *intent* — one more network where the
user is a first-class, self-hosted citizen rather than a tenant — but it is **not
a W3C/IETF open standard** and its data model diverges sharply from everything
else in `@dwk`. It was originally filed as a strategic question; it is now
scaffolded because the package is the cleanest expression of the
[no-instances thesis](https://overreacted.io/there-are-no-instances-in-atproto/):
identity is a DID the user controls and hosting is a swappable service entry, so
"which server" is not identity-defining. The caveats below still hold — read them
before extending it.

## Implementation notes (as built)

The package is built and tested, with deliberate, documented divergences from a
hosted reference PDS to stay Workers-native and dependency-minimal (the one
vendored runtime dependency is `@noble/curves`, pulled in only for the opt-in
secp256k1 signing curve):

- **Signing curve is P-256 by default; secp256k1 (K-256) is opt-in.** AT
  Protocol's cryptography spec admits both. WebCrypto supports P-256 (`p256`,
  multicodec 0x1200) natively but not secp256k1, so P-256 remains the
  dependency-free **default**. Because real Bluesky accounts sign with K-256
  (multicodec 0xe7) — and being a drop-in for a migrated account therefore
  requires it — the package also supports secp256k1 via the audited
  `@noble/curves` `secp256k1` (the one vendored elliptic-curve dependency;
  measured ≈35 KB minified, negligible against the Worker script budget). The
  curve is **per-account config** (`signingCurve`), fixed at repository genesis
  and persisted alongside the key so verification never infers it from raw key
  bytes. Both curves emit compact (64-byte `r‖s`), **low-S normalised**
  signatures over the SHA-256 digest; K-256 signing is deterministic (RFC 6979).
- **Identity defaults to `did:web`; `did:plc` is opt-in and being added.** For a
  `did:web` account the DID, handle binding (`/.well-known/atproto-did`), and DID
  document (`/.well-known/did.json`) all live under the user's own origin — no
  external PLC directory, which keeps the default on-thesis. Because most real
  Bluesky accounts are PLC-rooted, `did:plc` support is being added as an opt-in
  (#182, `didMethod: "plc"`): the operation core (`plc.ts`) **and** the Durable
  Object wiring have landed — a fresh `did:plc` account generates a DO-custodied
  secp256k1 **rotation key**, self-signs a genesis operation, derives its
  `did:plc:` DID, and serves it consistently (the front door routes the DO by a
  stable host key, forwards `/.well-known/atproto-did` to the DO, and returns 404
  for `/.well-known/did.json` since a PLC account's document lives in the
  directory). The (injectable) PLC **directory client** has also landed
  (`plc-directory.ts`): submit an operation (`POST /:did`), resolve a DID
  (`GET /:did`), and read its data state (`GET /:did/data`), with `fetch`
  injected so it unit-tests with a fake transport. When `plcDirectoryUrl` is
  configured, a freshly minted account registers its genesis operation with the
  directory **via a Durable Object alarm** — repo init (and the first request)
  never blocks on the external call, and the alarm **retries with exponential
  backoff** (10 s → capped at 1 h, up to 10 attempts) until the directory accepts
  it, surviving hibernation. The persisted directory URL lets the alarm run
  without a request; the `plc_submitted` flag stops it once registered. The
  default is unset, so nothing reaches the network unless asked. `did:plc` necessarily depends on the external
  PLC directory — a trade-off accepted only to interoperate with the existing
  network, never made the default. **Rotation-key custody:** the key is generated
  inside and never leaves the DO, exactly like the repository signing key. The
  resolve/data helpers are what inbound migration (#183) reads to learn a foreign
  account's keys and services.
- **The MST is rebuilt from the full entry set on each commit.** Because an MST's
  shape is a pure function of its `{key → value}` entries (a key's layer is fixed
  by `SHA-256(key)`), rebuilding the canonical tree is far simpler than
  incremental node splitting and is trivially correct/interoperable. Records live
  in DO SQLite; node blocks are recomputed for commits and CAR export.
- **Storage core is self-contained.** DAG-CBOR, CIDv1, the MST, CAR, and commit
  signing are implemented directly on WebCrypto in this package — it shares
  neither `@dwk/store` nor `@dwk/rdf`, exactly as anticipated below.
- **Scope is a single-account PDS.** One account per `baseUrl`; sessions
  authenticate the one owner via a configured password → HS256 access/refresh
  JWTs. The firehose (`subscribeRepos` over hibernatable WebSockets) is in
  progress (#184): the pure **frame encoder** (`firehose.ts` — the DAG-CBOR
  header + `#commit` body framing) has landed; the Durable Object WebSocket
  endpoint (hibernatable accept, the persisted `seq` cursor, per-commit broadcast,
  and `?cursor=` backfill) is the next increment. `did:plc` (#182) and account
  migration (#183) are complete.

## Why it does not fit the way the others do

The IndieWeb / Solid / fediverse packages all share two cheap reuses: **HTTP
resources** and **RDF** (`@dwk/rdf`, reused by Solid, ActivityPub, VC, LDN). A
PDS shares **neither**:

- **Repository = signed Merkle Search Tree, not HTTP resources.** A PDS account
  is a content-addressed **MST of records (IPLD/DAG-CBOR)**, exported/synced as
  **CAR files**, with a per-commit signature over the tree root. This is much
  closer to a git object store than to the `key → { rdf | blob }` model
  [`@dwk/store`](store.md) provides — so, unlike [`@dwk/remotestorage`](remotestorage.md),
  it **cannot** ride on the existing store; it needs a new MST/blockstore layer.
- **Records are lexicon-typed JSON, not RDF.** AT Protocol uses **Lexicon**
  schemas + DAG-CBOR, not JSON-LD/Turtle, so `@dwk/rdf` does not apply.
- **Signing keys, not just tokens.** Each commit is **signed with the account's
  repository signing key** (secp256k1/k-256). The PDS must custody/operate that
  key — a materially different security posture from the project's
  DPoP-bound-bearer + WAC model. (This *does* align with the key custody
  [`@dwk/vc`](vc.md) already contemplates for `did:web`.)
- **Identity via DID PLC (or did:web).** Handle resolution and the
  recommendation toward **did:plc** pull in an external operator (the PLC
  directory) — a centralization the rest of the cohort avoids. `did:web` is
  supported by AT Protocol and would keep identity at the user's domain, at the
  cost of some network-norm friction.
- **Federation shape is different.** Outbound is a **firehose / repo sync**
  (`com.atproto.sync` — `subscribeRepos`, CAR exports) consumed by Relays and
  App Views, not `POST`-to-inbox fan-out with HTTP Signatures like ActivityPub.

## What a Workers-native PDS would need

If pursued, the architecture mirrors [`@dwk/solid-pod`](solid-pod.md)'s
"stateless front door over a per-account DO authority", but with a **new storage
core**:

- **XRPC endpoint surface** (`/xrpc/<nsid>`) for `com.atproto.repo.*`
  (`createRecord`/`putRecord`/`deleteRecord`/`getRecord`/`listRecords`),
  `com.atproto.server.*` (sessions), `com.atproto.sync.*` (CAR export, repo
  status), and blob upload/serve (`uploadBlob` → R2).
- **Per-account repository DO** as the single-writer authority that holds the
  **MST + signs each commit**, keeping the signing key inside the DO and the
  commit chain strongly consistent.
- **Blockstore** = DAG-CBOR blocks (DO SQLite for the MST nodes, R2 for the
  CAR/blob bodies) — a **new** layer; `@dwk/store`'s RDF tier is unused.
- **Firehose** via the DO's **hibernatable WebSockets** (the same primitive
  `@dwk/solid-pod` uses for Solid Notifications and `@dwk/activitypub` for
  delivery), emitting `#commit` events on write.
- **Identity:** prefer `did:web` (reuses the [`@dwk/vc`](vc.md) DID surface);
  treat `did:plc` as an opt-in that introduces an external dependency.

## Related work / when to use Cirrus instead

[Cirrus](https://github.com/ascorbic/cirrus) (`@getcirrus/pds`, MIT) is a
single-user AT Protocol PDS on the same Cloudflare primitives (Worker + Durable
Object + R2) — effectively the same scope as this package. The honest difference
is **reach vs. fit**:

- **Cirrus is further along on real-network interop.** It supports `did:plc` as
  well as `did:web`, has tested **account migration** from an existing PDS, and
  ships the **firehose** (`subscribeRepos`). Closing that gap is now in progress
  here per the parity tracker
  [#180](https://github.com/davidwkeith/workers/issues/180): **secp256k1 signing**
  ([#181](https://github.com/davidwkeith/workers/issues/181)) and **`did:plc`
  support** ([#182](https://github.com/davidwkeith/workers/issues/182) — operation
  core, account wiring, and the directory client) have landed; **account
  migration** ([#183](https://github.com/davidwkeith/workers/issues/183)) is in
  progress — the CAR **import core** (`migrate.ts`) and the
  **`com.atproto.repo.importRepo`** handler have landed: an authenticated import
  resolves the source account's signing key from its DID document
  (`resolve.ts` — the directory for `did:plc`, the origin for `did:web`, decoding
  the `Multikey` via `decodeMultikey`), **verifies** the CAR's root commit against
  it, replaces the record set with the imported records, and **re-signs a fresh
  head** with our key chaining `prev` to the imported head (the agreed model;
  pre-migration history beyond that boundary is not retained by the current-state
  store). The **account-status cutover** is also wired —
  `activateAccount`/`deactivateAccount` toggle the home, and
  `getRepoStatus`/`checkAccountStatus` report it, which is how a Relay learns
  which PDS is the live home. **Blob accounting** is wired too —
  `com.atproto.sync.listBlobs` enumerates held blobs and
  `com.atproto.repo.listMissingBlobs` lists blobs referenced by records but not
  yet uploaded, so a migrating client knows exactly which blobs to transfer (via
  the existing `uploadBlob`) to finish the move. **PLC key rotation** is wired on
  the PDS's side: `com.atproto.identity.getRecommendedDidCredentials` recommends
  the credentials that re-point the DID at this PDS (our signing key, our
  endpoint, our rotation key for a minted account), and `buildRotationOperation`
  constructs the chained PLC op — the migrating client signs it with the rotation
  key it controls (we never hold a migrated account's rotation key) and submits
  it. That completes the migration surface; the **firehose** (#184) is the last
  parity gap. Until migration is complete, a user
  who wants to **migrate an existing Bluesky account today** is better served by
  Cirrus.
- **Cirrus is a standalone deployable app, not a composable library.** It does not
  export the `createX(config)` handler shape the
  [composition contract](../composition-contract.md) requires, so it cannot be
  mounted alongside `@dwk/solid-pod`, `@dwk/activitypub`, etc. behind one Worker /
  one domain — it is a second Worker. `@dwk/atproto-pds` exists precisely to be
  that mountable, on-thesis (`did:web`, dependency-minimal) member of the cohort.

**Guidance:** if you want full-network parity (PLC accounts, migration, firehose)
and are content running a dedicated Worker, prefer Cirrus. Use `@dwk/atproto-pds`
when you want the PDS composed into a single multi-standard Worker on the cohort's
terms. Whether to close the parity gap here at all is the open scope question
below, now tracked with concrete cost in
[#180](https://github.com/davidwkeith/workers/issues/180).

## Open questions (must resolve before committing)

- **Scope fit.** Does a non-W3C, key-custodial, MST-based server belong in `@dwk`
  at all, or is it a separate project? (Mirrors the [`@dwk/webauthn`](webauthn.md)
  "does this belong in scope" open question, but larger.) The cost of reaching
  network parity with a standalone server like Cirrus is now itemised in the
  parity tracker [#180](https://github.com/davidwkeith/workers/issues/180)
  (K-256 #181, `did:plc` #182, migration #183, firehose #184).
- **Spec churn.** AT Protocol is still evolving faster than the frozen W3C/IETF
  specs the rest of the cohort targets; conformance is a moving target.
- **No reuse dividend.** Because it shares neither the store nor `@dwk/rdf`, the
  marginal cost is high — closer to a greenfield package than the "low-marginal-
  cost" additions ([`@dwk/vc`](vc.md), [`@dwk/webfinger`](webfinger.md)) were.

## Conformance / testing

- Interop against the reference PDS / Relay / App View and the published
  Lexicon/repo/sync specs; there is no frozen conformance suite. See
  [conformance-and-testing.md](../conformance-and-testing.md).
