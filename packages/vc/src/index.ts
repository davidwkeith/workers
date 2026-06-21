/**
 * `@dwk/vc` — `did:web` identity plus Verifiable Credential issuance and
 * verification.
 *
 * Endpoint package (+ lib): exports a factory returning a `fetch`-compatible
 * handler, mountable under any prefix so it composes with the other `@dwk`
 * packages in one Worker. Decentralized identity is rooted at the user's own
 * domain — the same WebID / IndieAuth identity root, expressed as a DID — and
 * credential proofs reuse the project's asymmetric, alg-allow-listed crypto
 * posture (`@dwk/dpop`, `@dwk/http-signatures`).
 *
 * The split: the **`did:web` DID document is a static file** ({@link buildDidDocument}
 * produces `/.well-known/did.json` — no Worker needed to resolve it), while the
 * Worker covers the dynamic parts — VC **issuance** (signing with the domain's
 * key), VC **verification**, and **status / revocation** whose bit-flips need a
 * strongly-consistent store. Proofs use the **JCS** Data Integrity cryptosuites
 * (`eddsa-jcs-2022`, `ecdsa-jcs-2019`), so the package canonicalizes with
 * {@link canonicalize} (RFC 8785) rather than shipping a JSON-LD/RDF
 * canonicalizer — staying within the Worker script-size budget.
 *
 * Credential construction and proof logic take **plain-data inputs** and
 * unit-test without a Workers runtime; only the issuance/status endpoints and
 * their D1-backed status store touch the runtime. Signing keys and issuer
 * identity arrive via config and a secret binding — never read from the global
 * environment (composition contract).
 *
 * @see spec/packages/vc.md
 * @packageDocumentation
 */

export { createVc } from "./handler.js";
export type { VcEnv, VcHandler } from "./handler.js";

export {
  resolveConfig,
  type VcConfig,
  type ResolvedVcConfig,
  type StatusConfig,
  type VcOperation,
  type AuthorizeOperation,
  type DidResolver,
} from "./config.js";

// Data Integrity (cryptosuites + proof pipeline)
export {
  importSigner,
  addProof,
  verifyProof,
  isSupportedCryptosuite,
  type Cryptosuite,
  type Signer,
  type JsonObject,
  type SecuredDocument,
  type AddProofOptions,
  type VerifyProofOptions,
  type VerifyProofResult,
  type VerificationMethod,
  type VerificationMethodResolver,
} from "./data-integrity.js";

// Credential data model (VCDM 2.0)
export {
  buildCredential,
  validateCredential,
  checkValidityPeriod,
  issuerId,
  VC_CONTEXT_V2,
  VERIFIABLE_CREDENTIAL_TYPE,
  type UnsignedCredential,
  type BuildCredentialOptions,
  type Issuer,
} from "./credential.js";

// did:web
export {
  didWebToUrl,
  urlToDidWeb,
  buildDidDocument,
  findVerificationMethod,
  createDidWebResolver,
  DID_CONTEXT_V1,
  MULTIKEY_CONTEXT_V1,
  JWK_CONTEXT_V1,
  type BuildDidDocumentOptions,
  type VerificationMethodInput,
  type VerificationRelationships,
  type DidWebResolverOptions,
  type FetchLike,
} from "./did-web.js";

// Bitstring Status List
export {
  buildStatusListCredential,
  buildStatusEntry,
  buildEncodedList,
  encodeBitstring,
  decodeBitstring,
  getBit,
  setBit,
  findStatusEntry,
  statusEntryIndex,
  createVcStatusStore,
  DEFAULT_STATUS_LIST_LENGTH,
  BITSTRING_STATUS_LIST_CREDENTIAL_TYPE,
  BITSTRING_STATUS_LIST_ENTRY_TYPE,
  BITSTRING_STATUS_LIST_SUBJECT_TYPE,
  type StatusPurpose,
  type StatusPurposeValue,
  type StatusListCredentialOptions,
  type VcStatusStore,
  type VcStatusStoreEnv,
} from "./status-list.js";

// XSD dateTimeStamp validation for VC temporal fields
export { isValidXsdDateTimeStamp, toXsdDateTime } from "./datetime.js";

// JCS canonicalization and multibase/Multikey codecs
export { canonicalize, canonicalizeToBytes, type JcsValue } from "./jcs.js";
export {
  base58btcEncode,
  base58btcDecode,
  base64urlEncode,
  base64urlDecode,
  encodeMultibaseBase58btc,
  encodeMultibaseBase64url,
  decodeMultibase,
  encodeEd25519Multikey,
  decodeMultikey,
  type DecodedMultikey,
} from "./multibase.js";

export { VcLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
