# @dwk/atproto-pds

AT Protocol Personal Data Server — endpoint + Durable Object for a self-hosted
Bluesky-network repository rooted at the user's own domain.

## What this is

A Workers-native AT Protocol PDS. A per-account repository Durable Object holds
the signing key, the record set (DO SQLite), and the signed commit chain; the
stateless front door routes the XRPC surface and the `did:web` identity
documents. The repository is a deterministic Merkle Search Tree of DAG-CBOR
records, exportable as a CAR whose root commit is signed with the account's P-256
key — portable and self-verifying, so hosting is swappable. This is the package
expression of "there are no instances in atproto".

## Spec

`spec/packages/atproto-pds.md` — authoritative requirements, including the
"why it does not fit the way the others do" caveats and the as-built decisions.

## Key constraints

- **Self-contained storage core.** Shares neither `@dwk/store` nor `@dwk/rdf`.
  DAG-CBOR, CIDv1, the MST, CAR, and commit signing are implemented in-package on
  WebCrypto. Keep it dependency-minimal — the only vendored runtime dependency is
  `@noble/curves`, used solely for the opt-in secp256k1 signing curve (WebCrypto
  cannot do K-256); do not reach for libraries where WebCrypto suffices.
- **Deterministic MST.** A key's layer is `SHA-256(key)` leading zero bit-pairs,
  so the tree is a pure function of its entries. The MST is **rebuilt from the
  full record set** on each commit and CAR export — do not add incremental
  node-splitting unless a real scale need appears; the rebuild is correct and
  far simpler.
- **DAG-CBOR is canonical.** Deterministic encoding (minimal ints, length-first
  then bytewise map-key sort, tag-42 CID links). The bytes are content-addressed,
  so any nondeterminism is a correctness bug.
- **P-256 default, secp256k1 opt-in, low-S.** Commit signatures are compact
  64-byte `r‖s`, low-S normalised, over the SHA-256 digest. P-256 is the default
  (WebCrypto, and WebCrypto does not guarantee low-S, so the normalisation in
  `crypto.ts` is load-bearing). secp256k1 (`signingCurve: "secp256k1"`) signs via
  `@noble/curves` (deterministic RFC 6979, low-S). The curve is fixed at genesis
  and persisted (`signing_curve`) so verification never infers it from raw key
  bytes — both curves are 65 bytes uncompressed.
- **Key custody in the DO.** The repository signing key is generated inside the
  Durable Object and never leaves it — not in config, not in the forwarded
  header. The front door never sees it.
- **`did:web` identity by default; `did:plc` opt-in (in progress).** For
  `did:web` the DID document and the `atproto-did` handle binding are served from
  the account's own origin — no PLC directory. For `did:plc` (#182,
  `didMethod: "plc"`) the DO mints a DO-custodied secp256k1 rotation key,
  self-signs a genesis op (`plc.ts`), derives the account's `did:plc`, and is the
  source of truth for it: the front door routes the DO by a stable host key (the
  did:plc isn't known until genesis), forwards `atproto-did` to the DO, and 404s
  `did.json` (a PLC doc lives in the directory). The account DID flows through
  `#accountDid()`, not `cfg.did`. The PLC **directory client** (`plc-directory.ts`,
  injectable `fetch`) submits the genesis op and resolves DIDs; the DO registers
  via a **Durable Object alarm** with exponential-backoff retry (never blocking
  init), only when `plcDirectoryUrl` is configured (default unset — the external
  directory is never the default path). The alarm reads its state from storage
  (`plc_directory_url`, `plc_genesis`, `account_did`, `plc_submitted`,
  `plc_attempts`) since it runs without request config.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- DO: `AtprotoRepoObject` (useSQLite)
- R2 bucket: `BLOBS`
- Compatibility flags: `nodejs_compat`

Has `test-harness.ts` (excluded from build and published files). Run after
`pnpm --filter @dwk/log build` (the workerd pool resolves `@dwk/log` from
`dist`).

```bash
pnpm test --project @dwk/atproto-pds
```

## File layout

```
src/index.ts        # public surface
src/config.ts       # AtprotoPdsConfig, Env fragment (REPO DO + BLOBS R2), resolution
src/handler.ts      # createAtprotoPds front door (identity docs + /xrpc routing)
src/object.ts       # AtprotoRepoObject Durable Object (records, MST, commits, blobs, sessions)
src/cbor.ts         # deterministic DAG-CBOR codec
src/cid.ts          # CIDv1 (dag-cbor + raw codecs, base32)
src/mst.ts          # Merkle Search Tree build/walk
src/car.ts          # CARv1 read/write
src/repo.ts         # commit format/sign/verify
src/crypto.ts       # P-256 + secp256k1 keygen/sign/verify, did:key, low-S
src/plc.ts          # did:plc operation core (build/sign/derive-DID/CID/verify)
src/plc-directory.ts # PLC directory client (submit/resolve, injectable fetch)
src/migrate.ts      # inbound migration: CAR import core (verify + recover records)
src/resolve.ts      # DID-document resolution → source signing key (did:web/did:plc)
src/identity.ts     # did:web document, handle validation
src/auth.ts         # session HS256 JWTs, constant-time compare
src/record.ts       # JSON ⇄ DAG-CBOR ($link/$bytes), at:// URIs
src/xrpc.ts         # XRPC error envelope, NSID/rkey validation
src/tid.ts          # sortable TID record keys / revisions
src/bytes.ts        # base32 / base58btc / hex
src/varint.ts       # unsigned LEB128
src/test-harness.ts # test-only DO class (not published)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
- `@noble/curves` — audited secp256k1, only for the opt-in K-256 signing curve.
