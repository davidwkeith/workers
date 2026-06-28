/**
 * `@dwk/atproto-pds` — an edge-native AT Protocol Personal Data Server.
 *
 * A self-hosted [AT Protocol](https://atproto.com/specs/atp) PDS rooted at the
 * user's **own domain**: the home of one account's repository in the Bluesky
 * network. It is the package embodiment of "there are no instances" — identity
 * is a `did:web` the user controls (served at `/.well-known/did.json` +
 * `/.well-known/atproto-did`), and the repository is a portable, signed,
 * content-addressed structure (a Merkle Search Tree of DAG-CBOR records,
 * exportable as a CAR), so hosting is a swappable service entry rather than an
 * identity-defining silo.
 *
 * The package is **not** protocol-agnostic: it is the AT Protocol endpoint. It
 * mirrors the architecture proven in `@dwk/solid-pod` and `@dwk/activitypub` —
 * a stateless Worker front door over a per-account Durable Object that is the
 * single authority for the repository signing key, the MST, and the signed
 * commit chain. Unlike the rest of the cohort it shares neither `@dwk/store`
 * (the repository is an MST/blockstore, not `key → { rdf | blob }`) nor
 * `@dwk/rdf` (records are lexicon-typed DAG-CBOR, not RDF), so its storage core
 * is self-contained and dependency-free, built directly on WebCrypto. Signing
 * uses P-256 (a spec-valid curve WebCrypto supports natively).
 *
 * @see spec/packages/atproto-pds.md
 * @packageDocumentation
 */

export { createAtprotoPds, type AtprotoPdsHandler } from "./handler.js";
export { AtprotoRepoObject } from "./object.js";

export {
  resolveConfig,
  forwardedConfig,
  INTERNAL_CONFIG_HEADER,
  type AtprotoPdsConfig,
  type AtprotoPdsEnv,
  type ResolvedConfig,
  type ForwardedConfig,
} from "./config.js";

export { CID, DAG_CBOR_CODEC, RAW_CODEC } from "./cid.js";
export { encodeCbor, decodeCbor, type CborValue } from "./cbor.js";
export {
  buildMst,
  walkEntries,
  keyLayer,
  type MstEntry,
  type MstResult,
} from "./mst.js";
export {
  formatCommit,
  verifyCommit,
  unsignedCommitBytes,
  COMMIT_VERSION,
  type UnsignedCommit,
  type SignedCommit,
  type FormattedCommit,
} from "./repo.js";
export { writeCar, readCar, type CarBlock, type ParsedCar } from "./car.js";
export {
  generateSigningKey,
  signData,
  verifyData,
  didKeyFromPublicKey,
  publicKeyMultibase,
  exportPublicKeyRaw,
  createRepoKeypair,
  loadSigner,
  type SigningCurve,
  type RepoKeypair,
  type Signer,
} from "./crypto.js";
export {
  buildDidDocument,
  didWebFromHost,
  isValidHandle,
  type DidDocumentInput,
} from "./identity.js";
export {
  signPlcOperation,
  unsignedPlcBytes,
  signedPlcBytes,
  didPlcFromGenesis,
  plcOperationCid,
  verifyPlcOperation,
  type UnsignedPlcOperation,
  type SignedPlcOperation,
  type PlcService,
} from "./plc.js";
export {
  submitPlcOperation,
  resolvePlcDid,
  fetchPlcData,
  DEFAULT_PLC_DIRECTORY,
  type FetchLike,
  type PlcDirectoryOptions,
} from "./plc-directory.js";
export {
  importRepoFromCar,
  type ImportedRepo,
  type ImportedRecord,
  type ImportRepoOptions,
  type ImportVerifyKey,
} from "./migrate.js";
export { TidClock, encodeTid, isValidTid } from "./tid.js";
export {
  jsonToCbor,
  cborToJson,
  atUri,
  recordPath,
  type JsonValue,
} from "./record.js";
export { XrpcError, isValidNsid, isValidRecordKey } from "./xrpc.js";

export type { Logger, Metrics } from "@dwk/log";
