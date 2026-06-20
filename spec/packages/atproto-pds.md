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
hosted reference PDS to stay Workers-native and dependency-free:

- **Signing curve is P-256, not K-256.** AT Protocol's cryptography spec admits
  both; WebCrypto supports P-256 (`p256`, multicodec 0x1200) natively but not
  secp256k1, so the PDS standardises on P-256 to avoid shipping an elliptic-curve
  dependency. Signatures are emitted compact (64-byte `r‖s`) and **low-S
  normalised**. K-256 would need a vendored curve and is deferred.
- **Identity is `did:web`, not `did:plc`.** The account DID, handle binding
  (`/.well-known/atproto-did`), and DID document (`/.well-known/did.json`) all
  live under the user's own origin — no external PLC directory. This is the
  decision that keeps the package on-thesis.
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
  JWTs. The firehose (`subscribeRepos` over hibernatable WebSockets) and `did:plc`
  remain future work.

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

## Open questions (must resolve before committing)

- **Scope fit.** Does a non-W3C, key-custodial, MST-based server belong in `@dwk`
  at all, or is it a separate project? (Mirrors the [`@dwk/webauthn`](webauthn.md)
  "does this belong in scope" open question, but larger.)
- **Spec churn.** AT Protocol is still evolving faster than the frozen W3C/IETF
  specs the rest of the cohort targets; conformance is a moving target.
- **No reuse dividend.** Because it shares neither the store nor `@dwk/rdf`, the
  marginal cost is high — closer to a greenfield package than the "low-marginal-
  cost" additions ([`@dwk/vc`](vc.md), [`@dwk/webfinger`](webfinger.md)) were.

## Conformance / testing

- Interop against the reference PDS / Relay / App View and the published
  Lexicon/repo/sync specs; there is no frozen conformance suite. See
  [conformance-and-testing.md](../conformance-and-testing.md).
