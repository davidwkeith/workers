# `@dwk/atproto-pds`

> Edge-native AT Protocol Personal Data Server: XRPC surface, a signed Merkle
> Search Tree repository, CAR sync, and `did:web` identity. Endpoint package +
> Durable Object.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/atproto-pds.md) for the full
requirements — including why this package is the cohort's **strategic outlier**.

A self-hosted [AT Protocol](https://atproto.com/specs/atp) **Personal Data
Server (PDS)** rooted at the user's **own** domain: the home of one account's
repository in the Bluesky network. It is the package embodiment of
[“there are no instances in atproto”](https://overreacted.io/there-are-no-instances-in-atproto/) —
identity is a `did:web` the user controls and hosting is a swappable service
entry in that DID document, so the repository is a portable, signed,
content-addressed structure rather than an identity-defining silo. It mirrors the
architecture proven in [`@dwk/solid-pod`](../solid-pod/README.md): a **stateless
front door** over a **per-account Durable Object** that is the single authority
for the repository signing key, the MST, and the signed commit chain.

Unlike the rest of the cohort it shares **neither** [`@dwk/store`](../store/README.md)
(the repository is an MST/blockstore, not `key → { rdf | blob }`) **nor**
[`@dwk/rdf`](../rdf/README.md) (records are lexicon-typed DAG-CBOR, not RDF), so
its storage core — DAG-CBOR, CIDv1, the MST, CAR, and commit signing — is
self-contained and built directly on WebCrypto.

## What it covers

- **Identity at your own domain** — `/.well-known/atproto-did` (handle → DID) and
  `/.well-known/did.json` (a `did:web` document advertising the repository
  signing key as a `Multikey` and the PDS as an `AtprotoPersonalDataServer`
  service).
- **XRPC surface** (`/xrpc/<nsid>`):
  - `com.atproto.server.*` — `createSession`, `getSession`, `refreshSession`,
    `describeServer`.
  - `com.atproto.repo.*` — `createRecord`, `putRecord`, `deleteRecord`,
    `getRecord`, `listRecords`, `describeRepo`, `uploadBlob`.
  - `com.atproto.sync.*` — `getRepo` (CAR export), `getLatestCommit`, `getBlob`,
    `listRepos`.
  - `com.atproto.identity.resolveHandle`.
- **A signed, portable repository** — records are DAG-CBOR blocks in a
  deterministic Merkle Search Tree; each write produces a new commit signed with
  the account's P-256 repository key (compact, low-S) and chained through `prev`.
  `getRepo` exports the whole thing as a CARv1 whose root commit verifies against
  the key in the DID document.
- **Blobs** stream to R2, addressed by their raw-codec CID.

## Design decisions

- **P-256 signing, not K-256.** Both are valid per AT Protocol's cryptography
  spec; WebCrypto supports P-256 natively, so the PDS uses it to stay
  dependency-free. The repo key is published as a `did:key` (multicodec 0x1200).
- **`did:web`, not `did:plc`.** Identity stays on the user's own origin — no
  external PLC directory.
- **Single-account scope.** One account per `baseUrl`, authenticated by a
  configured password. The firehose and `did:plc` are future work.

## Usage

```ts
import { createAtprotoPds, AtprotoRepoObject } from "@dwk/atproto-pds";

const pds = createAtprotoPds({
  baseUrl: "https://alice.example.com",
  password: env.ACCOUNT_PASSWORD, // secret binding
  jwtSecret: env.SESSION_SECRET, // secret binding
});

export default {
  fetch: (request, env, ctx) => pds(request, env, ctx),
};

export { AtprotoRepoObject };
```

The composed Worker must bind the `REPO` Durable Object namespace
(`AtprotoRepoObject`) and the `BLOBS` R2 bucket; a missing binding fails loudly
at startup.

## License

ISC
