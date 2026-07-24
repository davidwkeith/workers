# @dwk/atproto-pds

## 0.1.0-beta.3

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5
  - @dwk/safe-fetch@0.1.0-beta.4

## 0.1.0-beta.2

### Minor Changes

- 39f6d61: Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).

### Patch Changes

- 3e505be: The `subscribeRepos` `?cursor=` backfill replay now enforces a 16 MiB total
  byte budget, closing the connection with a `BackfillOverflow` error frame if
  exceeded, instead of queuing an unbounded burst (up to ~1 GiB in the worst
  case) onto the socket with no flow control. Workers' `WebSocket` exposes no
  `bufferedAmount` to gate on, and the replay must stay synchronous (no
  `await`) to preserve its no-concurrent-commit-interleaving guarantee, so the
  fix bounds the total instead of waiting for the client to drain. The matching
  rows are now iterated directly off the SQL cursor rather than `.toArray()`'d
  up front, so the byte budget also gates further reads from SQLite (not just
  sends to the socket) — the initial fix only bounded what reached the wire,
  still risking the DO's memory budget while building the full row set.
- e06db4f: Stream `com.atproto.sync.getRepo` (and the `tooBig` firehose fallback it backs)
  instead of buffering the whole repository CAR in the Durable Object, closing
  #296. `#getRepo` previously decoded every record body up front via `#entries()`
  and concatenated the entire CAR into one `Uint8Array` response body — a large
  account could overrun the DO's 128 MB memory limit, and every Relay/AppView
  full sync hit this path. `#getRepo` now builds its MST entries without decoding
  record bodies (`#mstEntries()`), and `car.ts`'s new `writeCarStream` returns a
  `ReadableStream` that encodes and enqueues one block at a time as the response
  is read, decoding at most one record body from the SQL cursor per pull instead
  of the whole repository at once.
- 36a3be1: Stop a client-controlled `Content-Type` on a served blob from becoming stored
  XSS (#299). Both packages serve public, unauthenticated blobs whose content type
  comes from the (client-controlled) upload, so an uploaded `text/html` (or
  `image/svg+xml`) would render as active content on the deployment's own origin —
  `@dwk/micropub`'s `media`-scope-only endpoint could thereby escalate to
  origin-level script execution. The serve paths now always send
  `X-Content-Type-Options: nosniff`, and only serve a known safe media type
  (image/video/audio) inline; anything else is served as an opaque
  `application/octet-stream` with `Content-Disposition: attachment`, so it
  downloads instead of executing. (Note that `nosniff` alone would not stop an
  explicit `text/html`, hence the inline allow-list.)
- Updated dependencies [0e65ce3]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.1

### Minor Changes

- f41f353: Add the account-status cutover endpoints — part of #183 (account migration).

  Migration coordinates a clean hand-off so the network has exactly one live home:
  the old PDS is deactivated and the new one activated. This adds that switch:

  - **`com.atproto.server.activateAccount` / `deactivateAccount`** — authenticated
    toggles of the account's active state (persisted in the repository DO).
  - **`com.atproto.sync.getRepoStatus`** — public status a Relay polls to decide
    whether to crawl this PDS: `{ did, active, status?, rev }` (`status: "deactivated"`
    when inactive).
  - **`com.atproto.server.checkAccountStatus`** — the owner's view: activation
    state, repo head/rev, and indexed-record count.
  - `com.atproto.sync.listRepos` now reports each repo's `active` flag.

  Accounts are active by default. Blob import and PLC key rotation are the
  remaining migration increments.

- 9002e6c: Add blob accounting for migration — part of #183 (account migration).

  A migration transfers blobs client-side (read the source's blobs, write them
  here via `uploadBlob`); the server's job is to enumerate what it holds and what
  records still reference but lack, so the client knows when the move is complete:

  - **`com.atproto.sync.listBlobs`** — the CIDs of blobs this account holds
    (validates the required `did`; paginated with `limit`/`cursor`).
  - **`com.atproto.repo.listMissingBlobs`** — blobs referenced by the record set
    but not yet uploaded (authenticated; paginated with `limit`/`cursor`).
  - **`extractBlobCids`** (in `record.ts`) — walk a record's DAG-CBOR for
    `{ $type: "blob", ref: <CID> }` references. Blob references are maintained in an
    indexed `record_blobs` table (updated on write/delete/import), so the
    referenced-blob set is a `SELECT DISTINCT` rather than a scan-and-decode of every
    record — keeping it within Worker CPU/DO memory limits for large repos.
  - `com.atproto.server.checkAccountStatus` now reports real `expectedBlobs` /
    `importedBlobs` counts (referenced vs held).

  PLC key rotation is the remaining migration increment.

- b22023e: Add the firehose frame encoder (`firehose.ts`) — increment 1 of #184, the last
  Cirrus-parity gap.

  Relays subscribe to `com.atproto.sync.subscribeRepos` to crawl a repository in
  real time; without it, records written here are not discoverable by the network.
  This lands the pure, Workers-runtime-free encoder for the event-stream frame
  format (two concatenated DAG-CBOR objects: a `{ op: 1, t }` header + the body):

  - **`encodeFrameHeader(t)`** — the message-frame header.
  - **`encodeCommitBody(commit)` / `encodeCommitFrame(commit)`** — the `#commit`
    body (and full frame) with every lexicon-required field: `seq`, `repo`,
    `commit`, `rev`, `since`, `blocks` (CAR), `ops` (`create`/`update`/`delete`
    with `path` + nullable `cid`), `time`, the deprecated `rebase`/`tooBig`/`blobs`
    defaults, and optional `prevData`.

  The Durable Object WebSocket endpoint — hibernatable accept, the persisted `seq`
  cursor, per-commit broadcast, and `?cursor=` backfill — is the next increment.

- b63e064: Ship the repository firehose — `com.atproto.sync.subscribeRepos` (#184), the last
  of the four Cirrus-parity gaps (#180). The pure frame encoder had already landed;
  this wires the live stream onto the per-account repository Durable Object.

  - **Hibernatable WebSocket endpoint:** `subscribeRepos` is accepted via
    `ctx.acceptWebSocket`, so a subscription survives the DO evicting from memory
    and resumes delivery without the consumer reconnecting.
  - **Per-commit broadcast:** every `createRecord` / `putRecord` / `deleteRecord`
    and a migration `importRepo` now emits a `#commit` event — a DAG-CBOR frame
    whose `blocks` CAR carries the signed commit block, the rebuilt MST nodes, and
    the changed records, so a Relay can apply the commit without a full `getRepo`.
  - **Monotonic, persisted `seq`** in DO SQLite, so the stream is ordered and
    resumable across restarts.
  - **`?cursor=` backfill:** a bounded ring of recent frames is replayed before the
    socket goes live; a cursor past the buffered window gets an `OutdatedCursor`
    info frame (then whatever remains), and a cursor ahead of the stream head gets
    a terminal `FutureCursor` error frame.
  - New `encodeInfoFrame` / `encodeErrorFrame` encoders (`op: 1` `#info` and the
    `op: -1` error header) join the existing `#commit` framing on the public
    surface.
  - **Write serialization:** the four commit-chain mutations (`createRecord`,
    `putRecord`, `deleteRecord`, `importRepo`) now run through a Durable Object
    write queue, so concurrent writes cannot interleave at `await` points and fork
    the linear commit chain (each used to read the same `prev` head). This upholds
    the package's single-writer invariant.

- 1b9b228: Add `com.atproto.identity.updateHandle` and emit a firehose `#identity` event.

  The account handle was fixed at config. `updateHandle` (owner-authenticated) now
  changes it: the new handle is persisted as an override and an **`#identity`**
  event (`{ seq, did, time, handle }`) is broadcast on the firehose — sharing the
  single `seq` space and `?cursor=` backfill ring with `#commit`/`#account` — so a
  subscribed Relay re-resolves the handle ⇄ DID binding without polling. The
  effective handle (override, else configured) now flows through every surface that
  reports it: `createSession`/`getSession`/`refreshSession`, `resolveHandle`,
  `describeRepo`, the `did:web` DID document `alsoKnownAs`, and
  `getRecommendedDidCredentials`. The change is serialized through the write chain
  and emits only on an actual handle change. Adds `encodeIdentityFrame` to the
  frame encoder.

  The PDS records the claimed handle; bidirectional verification (the new handle
  resolving back to this DID via DNS `_atproto` or `/.well-known/atproto-did`)
  remains the network's job, as in the reference PDS.

- b051f50: Wire account migration into the PDS — increment 2 of #183: the
  `com.atproto.repo.importRepo` handler that imports a real source repository.

  - **`com.atproto.repo.importRepo`** — an authenticated import that resolves the
    source account's signing key from its DID document, **verifies** the uploaded
    CAR's root commit against it, replaces the record set with the imported records
    (stored verbatim so their CIDs are preserved), and **re-signs a fresh head**
    commit with this PDS's key, chaining `prev` to the imported head (the agreed
    "re-sign on top" model). The current-state store keeps the imported records; the
    source's deeper commit history is not retained.
  - **`resolve.ts`** — `resolveDidDocument` / `resolveSigningKey`: fetch an
    account's DID document (the PLC directory for `did:plc`, the origin's
    `/.well-known/did.json` for `did:web`) and recover its repository signing key.
    `fetch` is injected for testing.
  - **`decodeMultikey`** (in `crypto.ts`) — the inverse of `publicKeyMultibase`:
    decode a `z…` Multikey back to a raw public key + curve (both P-256 and
    secp256k1), reading the multicodec prefix and decompressing the SEC1 point.

  The remaining migration pieces follow in later increments: blob import, the
  `activate`/`deactivate` cutover with account-status reporting, and PLC key
  rotation.

- 79d704c: Add `@dwk/atproto-pds` — a Workers-native AT Protocol Personal Data Server
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

- f4c464f: Add the inbound-migration **CAR import core** (`migrate.ts`) — increment 1 of
  #183, the last Cirrus-parity gap, now unblocked by k-256 (#181) and did:plc
  (#182).

  The standard migration flow exports the source repository as a CAR
  (`com.atproto.sync.getRepo` on the old PDS) and imports it onto the new one. This
  change lands the pure, Workers-runtime-free core that turns those CAR bytes back
  into a verified repository:

  - **`importRepoFromCar(carBytes, { verifyKey? })`** — parses the CAR, decodes the
    root commit, optionally **verifies its signature** against the source account's
    repository key (a mismatch throws), then walks the MST to recover every
    `collection/rkey → record` entry from the same block bag. Returns the DID, rev,
    signed commit, head CID, and the flat record set. Throws on a missing root,
    missing block, or unsupported commit version.

  The repository is self-verifying, so an import can trust the export end-to-end
  before writing anything. Wiring this into the Durable Object (the `importRepo`
  XRPC + `createAccount`-with-existing-DID), importing referenced blobs, the
  activate/deactivate cutover, and PLC rotation are the following increments.

- de9272e: Wire `did:plc` into the PDS — increment 2 of #182. A fresh `did:plc` account now
  works end to end within the PDS (directory submission is the remaining piece).

  - **New `didMethod: "web" | "plc"` config** (defaults to `"web"`). `"web"` is
    unchanged. `"plc"` mints a `did:plc` account at genesis.
  - **DO genesis for `did:plc`** — the Durable Object generates a **DO-custodied
    secp256k1 rotation key** (generated inside, never emitted, like the signing
    key), self-signs a genesis operation, derives the account's `did:plc`, and
    persists both. An existing `did:plc` can be adopted by passing `did` (for
    migration). The account DID now flows through the derived value everywhere
    (commits, sessions, `at://` URIs, blob keys, describe/list), not the config DID.
  - **Front door routing** now keys the per-account DO by a stable host key rather
    than the DID (a fresh `did:plc` isn't known until genesis). For `did:plc`
    accounts, `/.well-known/atproto-did` is served from the DO and
    `/.well-known/did.json` returns 404 (a PLC account's document lives in the
    directory). `did:web` behaviour is unchanged.
  - A `config.did` that disagrees with `didMethod` is now rejected at startup.

  The injectable PLC **directory client** (submitting the genesis operation and
  resolving foreign DIDs — also needed by migration #183) lands in the next
  increment. The external PLC directory remains opt-in and never the default.

- 37030fb: Add the **PLC directory client** — increment 3 of #182, completing `did:plc`
  support (registration + resolution).

  - **New `plc-directory.ts`** with an injectable `fetch`: `submitPlcOperation`
    (`POST /:did` — register a genesis op or append a rotation), `resolvePlcDid`
    (`GET /:did` — resolve a DID document, `null` on 404), and `fetchPlcData`
    (`GET /:did/data` — the current rotation keys / verification methods / services
    an inbound migration reads). Errors surface the directory's status and body.
  - **New `plcDirectoryUrl` config.** When set and `didMethod` is `"plc"`, the DO
    registers its freshly minted genesis operation with the directory **via a
    Durable Object alarm** — repo init (and the first request) never blocks on the
    external call, and the alarm **retries with exponential backoff** (10 s →
    capped at 1 h, up to 10 attempts) until the directory accepts it, surviving
    hibernation. It **defaults to unset** — the account is locally self-consistent
    and nothing reaches the network unless asked, which also keeps tests hermetic.
  - Exported from the package surface; the resolve/data helpers are what account
    migration (#183) will use to read a foreign account's keys and services.

  The external PLC directory remains opt-in and never the default path.

- ac2c167: Add the **`did:plc` operation core** (`plc.ts`) — increment 1 of #182, the second
  Cirrus-parity gap (#180).

  Most real Bluesky accounts are PLC-rooted, so hosting or migrating one in requires
  speaking `did:plc`. This change lands the pure, Workers-runtime-free core that
  builds, signs, and identifies PLC operations using only the existing DAG-CBOR /
  SHA-256 / base32 / curve primitives (did:plc spec v0.1 wire format):

  - `signPlcOperation` / `unsignedPlcBytes` / `signedPlcBytes` — sign a genesis or
    rotation operation over its DAG-CBOR-without-`sig` encoding; the signature is
    the low-S 64-byte `r‖s` (secp256k1 or P-256 rotation key) base64url-encoded
    without padding.
  - `didPlcFromGenesis` — derive `did:plc:` + the first 24 base32 chars of
    `SHA-256(signed genesis op)`.
  - `plcOperationCid` — the CID string of a signed op, used as the next op's `prev`.
  - `verifyPlcOperation` — verify an op's signature against a rotation key.
  - New `base64urlEncode` / `base64urlDecode` byte helpers.

  `did:web` remains the default. The Durable Object wiring and the injectable PLC
  **directory client** (submission/resolution) land in increment 2; `did:plc`
  necessarily depends on the external PLC directory, a trade-off accepted only to
  interoperate with the existing network and never made the default.

- 4c675df: Add PLC key-rotation building blocks — the last migration piece of #183.

  Re-pointing a `did:plc` at the new PDS requires a rotation operation signed with
  a key the account controls. The PDS never holds a migrated account's rotation
  key, so it **recommends** the credentials and provides the op constructor; the
  migrating client signs and submits:

  - **`com.atproto.identity.getRecommendedDidCredentials`** (authenticated) —
    recommends the DID credentials that point the account at this PDS: our signing
    key (`verificationMethods.atproto`), our endpoint (`services.atproto_pds`), the
    account handle (`alsoKnownAs`), and — for a `did:plc` this PDS minted — its
    rotation key.
  - **`buildRotationOperation`** (in `plc.ts`) — build the next PLC operation from
    the previous one, applying field updates and chaining `prev` to its CID, ready
    to sign with a current rotation key (via `signPlcOperation`) and submit with the
    directory client.

  This completes the account-migration surface (#183); the firehose (#184) is the
  remaining Cirrus-parity gap.

- 0a4bcbb: Add **secp256k1 (K-256) commit signing** as an opt-in alternative to the default
  P-256, the first step toward network parity with a full PDS (#181, part of #180).

  secp256k1 is AT Protocol's network-preferred curve and the one existing Bluesky
  accounts already sign with, so it is a prerequisite for being a drop-in target
  for a migrated account. WebCrypto cannot do K-256, so it is implemented over the
  audited `@noble/curves` `secp256k1` (deterministic RFC 6979, low-S, compact
  64-byte `r‖s` over the SHA-256 digest — matching the P-256 path). Measured bundle
  cost is ≈35 KB minified, negligible against the Worker script-size budget.

  - New config `signingCurve?: "p256" | "secp256k1"` (defaults to `"p256"`). The
    curve is **fixed at repository genesis** and persisted alongside the key, so
    verification never has to infer it from raw key bytes (both curves are 65 bytes
    uncompressed).
  - The DID document publishes the key as a curve-correct `Multikey` —
    multicodec `0xe7` (`secp256k1-pub`, `zQ3sh…`) or `0x1200` (`p256-pub`,
    `zDn…`).
  - New public API: `createRepoKeypair`, `loadSigner`, and the `SigningCurve` /
    `RepoKeypair` / `Signer` types. `verifyData`, `verifyCommit`,
    `publicKeyMultibase`, and `didKeyFromPublicKey` take an optional trailing
    `curve` argument (defaulting to `"p256"`, so existing call sites are
    unaffected).

  P-256 remains the dependency-free default; `did:web` identity, single-account
  scope, and the rest of the as-built behaviour are unchanged.

### Patch Changes

- c2fd02f: Verify every CAR block against its content address on inbound migration import
  (`importRepoFromCar`).

  The import path authenticated only the **root commit signature** and then trusted
  the CAR's self-declared block CIDs when walking the MST and reading records. Block
  bytes were never re-hashed against the CID they were filed under, so a malicious or
  buggy source could swap MST-node or record bytes beneath the expected CIDs and the
  root-commit signature would still verify while the recovered records were forged —
  breaking the content-address chain the signature is supposed to anchor.

  `importRepoFromCar` now recomputes each block's CIDv1/SHA-256 and rejects the CAR
  (`block … does not match its content`) if any block fails to match, so the signed
  root transitively authenticates every record before a single one is imported.

- c2fd02f: Make the DAG-CBOR codec strict, matching the canonical profile the AT Protocol
  data model requires.

  DAG-CBOR bytes are content-addressed, so any non-canonical encoding of the same
  data carries a different CID than a re-encode — accepting it silently is a
  correctness bug. The codec now:

  - **rejects floats** on both encode (a non-integer or non-finite number throws)
    and decode (a major-7 half/single/double-float head throws) — the atproto data
    model forbids floats outright;
  - **rejects non-minimally-encoded integers** on decode (e.g. a value `< 24`
    carried in a one-byte follow);
  - **rejects out-of-order or duplicate map keys** on decode (keys must be in
    length-first-then-bytewise canonical order).

  Previously the decoder accepted all three, so a non-canonical block could round
  -trip without its CID being challenged. This hardens the codec against malformed
  or adversarial blocks (e.g. on CAR import).

- 92e6617: Emit a firehose **`#account`** event on the migration activate/deactivate cutover.

  `subscribeRepos` already streamed `#commit` events, but toggling the account's
  hosting status (`com.atproto.server.activateAccount` /
  `deactivateAccount`) only flipped local state — a subscribed Relay would learn of
  a cutover only by re-polling `com.atproto.sync.getRepoStatus`. The cutover now
  broadcasts an `#account` event (`{ seq, did, time, active, status? }`, with
  `status: "deactivated"` when inactive) over the firehose, sharing the same
  monotonic `seq` space and `?cursor=` backfill ring as `#commit`, so a Relay
  updates the live home in real time. The event is emitted only on an actual
  state transition. Adds `encodeAccountFrame` to the frame encoder.

- 1d1ae48: Complete the firehose `#commit` event body: populate `blobs` and add a `tooBig`
  fallback.

  - **`blobs`** — a `#commit` now lists the CIDs of blobs newly referenced by the
    records it created/updated (derived from the record content), so a consumer
    knows which blobs to fetch without decoding every record itself. Previously the
    field was always empty.
  - **`tooBig`** — because the package rebuilds the whole MST into every frame, a
    large repo's per-commit diff can outgrow the WebSocket message ceiling. When a
    commit's blocks CAR exceeds the new `firehoseMaxBlocksBytes` config (default
    1 MiB), the event is emitted with `tooBig: true`, an empty blocks CAR (carrying
    only the commit root) and no `ops`/`blobs`, signalling the consumer to fall
    back to `getRepo`. Previously `tooBig` was always false and an oversized frame
    could exceed the message limit.

  Adds `firehoseMaxBlocksBytes` to `AtprotoPdsConfig` (operator-tunable; also makes
  the `tooBig` path testable).

- c2fd02f: Two review follow-ups to the spec-conformance pass:

  - **Bound CAR-import block verification concurrency.** `importRepoFromCar`
    verified every block's content address with `Promise.all(blocks.map(…))`, which
    materialises one pending promise per block at once — tens of thousands on a
    large repo, whose closure/promise overhead is itself a cost against the Worker's
    128 MB ceiling. A small fixed pool of workers pulling from a shared cursor now
    caps in-flight digests while still parallelising the SHA-256s.
  - **Memoise immutable repository config reads.** The signing curve and raw public
    key are fixed at genesis, so `AtprotoRepoObject` now caches them on the instance
    (like the account DID) instead of issuing a SQLite-KV read on every identity
    request.

- c2fd02f: Two small spec-conformance follow-ups from the review:

  - **`com.atproto.repo.listRecords` now honours `reverse`.** With `reverse=true`
    the listing is returned in descending record-key order and the cursor pages
    downward (`rkey < cursor`); the default (ascending) behaviour is unchanged.
  - **The `did:web` DID document no longer advertises the secp256k1 key suite for a
    P-256 account.** The `@context` carried
    `https://w3id.org/security/suites/secp256k1-2019/v1` unconditionally, which is
    wrong for the default P-256 curve. The verification method is a self-describing
    `Multikey`, so `multikey/v1` covers both curves; the legacy secp256k1 suite
    context is now included only when the signing curve is secp256k1.

- c2fd02f: Tighten NSID validation (`isValidNsid`) to match the AT Protocol NSID syntax.

  The previous regex accepted any string of two-or-more dot-separated segments and
  applied the authority charset to every segment, so it wrongly accepted
  two-segment names (e.g. `app.bsky`) and hyphens in the trailing name segment
  (e.g. `com.example.foo-bar`). `isValidNsid` now requires:

  - at least **three** segments — the authority (every segment but the last) must
    itself be ≥2 segments, plus the trailing name segment;
  - every segment to start with an ASCII letter, be 1–63 chars of letters, digits
    and hyphens, and not end with a hyphen;
  - the final **name** segment to be letters and digits only (no hyphens);
  - the whole NSID to be ≤317 chars.

- c2fd02f: Harden DAG-CBOR decode and JSON⇄CBOR record conversion against prototype
  pollution.

  `decodeCbor` (map case), `jsonToCbor`, and `cborToJson` populated their result
  objects with `obj[key] = …`. A `__proto__` key would then hit the inherited
  `__proto__` setter and poison the object's prototype chain instead of becoming an
  own data property. Records and CAR blocks are untrusted input, so this was
  reachable from an XRPC `createRecord` body or an imported block.

  All three now route key assignment through a small `assignKey` helper: a `__proto__`
  key is written via a data descriptor (which sidesteps the setter) and every other
  key uses plain assignment. The result keeps the standard `Object.prototype`
  consumers expect while the prototype chain is never touched. Adds regression
  tests for the decode and `jsonToCbor` paths.

- 22c802a: `resolveDidDocument`'s `did:web` fetch and all three PLC-directory calls
  (`submitPlcOperation`, `resolvePlcDid`, `fetchPlcData`) now go through
  `@dwk/safe-fetch` (#215): a bounded timeout and redirect handling where
  previously there was neither.
- Updated dependencies [6d14fc3]
- Updated dependencies [7b86416]
- Updated dependencies [22c802a]
  - @dwk/log@0.1.0-beta.3
  - @dwk/safe-fetch@0.1.0-beta.2
