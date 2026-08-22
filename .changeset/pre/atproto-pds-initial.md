---
"@dwk/atproto-pds": minor
---

Add `@dwk/atproto-pds` — a Workers-native AT Protocol Personal Data Server
rooted at the user's own domain. Scaffolded in answer to
["there are no instances in atproto"](https://overreacted.io/there-are-no-instances-in-atproto/):
identity is a `did:web` the user controls and hosting is a swappable service
entry, so the repository is a portable, signed, content-addressed structure
rather than an identity-defining silo. It mirrors the `@dwk/solid-pod` /
`@dwk/activitypub` architecture — a stateless front door over a per-account
repository Durable Object — but is the cohort's strategic outlier: it shares
**neither** `@dwk/store` nor `@dwk/rdf`, so its storage core is self-contained.

- **`createAtprotoPds(config)`** returns the standard
  `(request, env, ctx) => Promise<Response>` handler and the package exports the
  `AtprotoRepoObject` Durable Object class. Identity, credentials, and limits are
  config-supplied — never read from the global environment — and the handler
  fails loudly when the `REPO` Durable Object or `BLOBS` R2 binding is missing.
- **Self-contained repository core**, built directly on WebCrypto: deterministic
  DAG-CBOR, CIDv1 (`dag-cbor` + `raw`), a Merkle Search Tree (rebuilt
  deterministically from the record set per commit), CARv1 export, and signed
  repository commits.
- **Identity at the user's own domain:** `/.well-known/atproto-did` (handle →
  DID) and a `/.well-known/did.json` `did:web` document advertising the
  repository signing key (`Multikey`) and the PDS service endpoint. No `did:plc`,
  no PLC directory.
- **XRPC surface:** `com.atproto.server.*` (session create/get/refresh,
  describeServer), `com.atproto.repo.*` (create/put/delete/get/listRecords,
  describeRepo, uploadBlob), `com.atproto.sync.*` (getRepo CAR export,
  getLatestCommit, getBlob, listRepos), and `com.atproto.identity.resolveHandle`.
- **Signing:** P-256 (a spec-valid curve WebCrypto supports natively; K-256 is
  deferred), compact 64-byte `r‖s` signatures, low-S normalised, published as a
  `did:key`. Each write produces a new commit chained through `prev`; a `getRepo`
  CAR's root commit verifies against the key in the DID document.
- **Sessions:** a single-account PDS authenticates its owner via a configured
  password to HS256 access/refresh JWTs; the repository signing key is generated
  inside the Durable Object and never leaves it.

The firehose (`com.atproto.sync.subscribeRepos`) and `did:plc` remain future
work. The package is exploratory/strategic (see `spec/packages/atproto-pds.md`).
