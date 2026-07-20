/**
 * Data Integrity proofs over JSON credentials, using the JCS cryptosuites.
 *
 * Implements `eddsa-jcs-2022` (Ed25519) and `ecdsa-jcs-2019` (ECDSA P-256 /
 * P-384) from the W3C Data Integrity specs. The proof pipeline is:
 *
 * 1. Build a **proof configuration** (the proof object minus `proofValue`),
 *    copying the document's `@context`.
 * 2. JCS-canonicalize the proof config and the document-without-proof, hash each
 *    with the cryptosuite's digest, and concatenate `proofConfigHash ‖ docHash`.
 * 3. Sign (or verify) that concatenation with the verification key.
 *
 * The proof value is multibase base58-btc. ECDSA signatures use the IEEE P1363
 * (`r ‖ s`) form Web Crypto produces, which is exactly what the cryptosuite
 * expects. Signing/verification mirror the `@dwk/dpop` and `@dwk/http-signatures`
 * posture — asymmetric only, an explicit cryptosuite allow-list, and the key is
 * validated against the claimed cryptosuite.
 *
 * Pure aside from Web Crypto: plain-data in, plain-data out, no runtime bindings.
 *
 * @see https://www.w3.org/TR/vc-di-eddsa/
 * @see https://www.w3.org/TR/vc-di-ecdsa/
 */

import { toXsdDateTime } from "./datetime.js";
import { canonicalize, canonicalizeToBytes, type JcsValue } from "./jcs.js";
import {
  base58btcDecode,
  decodeMultikey,
  encodeMultibaseBase58btc,
  MULTIBASE_BASE58BTC,
} from "./multibase.js";

/** A JSON object with string keys — a credential, proof, or proof config. */
export type JsonObject = { [key: string]: JcsValue | undefined };

/** The Data Integrity cryptosuites this package implements. */
export type Cryptosuite = "eddsa-jcs-2022" | "ecdsa-jcs-2019";

/** Whether `value` names a supported cryptosuite. */
export function isSupportedCryptosuite(value: unknown): value is Cryptosuite {
  return value === "eddsa-jcs-2022" || value === "ecdsa-jcs-2019";
}

type ComponentHash = "SHA-256" | "SHA-384";

// Structural Web Crypto algorithm/param shapes. We avoid the DOM lib names
// (EcKeyImportParams, EcdsaParams, …) because @cloudflare/workers-types does not
// declare them; these objects are accepted structurally by crypto.subtle.
interface AlgParams {
  name: string;
  namedCurve?: string;
  hash?: string;
}
type SignVerifyParams = AlgParams;

/** A resolved signing key plus the cryptosuite parameters it implies. */
export interface Signer {
  readonly key: CryptoKey;
  readonly cryptosuite: Cryptosuite;
  readonly componentHash: ComponentHash;
  readonly params: SignVerifyParams;
}

function ecParamsForCurve(curve: string): {
  cryptosuite: Cryptosuite;
  componentHash: ComponentHash;
  params: SignVerifyParams;
} {
  if (curve === "P-256") {
    return {
      cryptosuite: "ecdsa-jcs-2019",
      componentHash: "SHA-256",
      params: { name: "ECDSA", hash: "SHA-256" },
    };
  }
  if (curve === "P-384") {
    return {
      cryptosuite: "ecdsa-jcs-2019",
      componentHash: "SHA-384",
      params: { name: "ECDSA", hash: "SHA-384" },
    };
  }
  throw new Error(
    `@dwk/vc: unsupported EC curve "${curve}" for ecdsa-jcs-2019`,
  );
}

/**
 * Import a private signing key from a JWK and resolve the cryptosuite it
 * implies: `OKP`/`Ed25519` → `eddsa-jcs-2022`; `EC`/`P-256`|`P-384` →
 * `ecdsa-jcs-2019`. Throws for unsupported or non-private keys.
 */
export async function importSigner(jwk: JsonWebKey): Promise<Signer> {
  if (jwk.d === undefined) {
    throw new Error(
      "@dwk/vc: signing key JWK is missing the private `d` member",
    );
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return {
      key,
      cryptosuite: "eddsa-jcs-2022",
      componentHash: "SHA-256",
      params: { name: "Ed25519" },
    };
  }
  if (jwk.kty === "EC" && typeof jwk.crv === "string") {
    const ec = ecParamsForCurve(jwk.crv);
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: jwk.crv },
      false,
      ["sign"],
    );
    return { key, ...ec };
  }
  throw new Error(
    `@dwk/vc: unsupported signing key (kty=${String(jwk.kty)}, crv=${String(jwk.crv)})`,
  );
}

async function digest(
  hash: ComponentHash,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.digest(hash, bytes);
  return new Uint8Array(out);
}

/** `proofConfigHash ‖ documentHash`, the bytes a JCS cryptosuite signs. */
async function hashData(
  proofConfig: JsonObject,
  document: JsonObject,
  componentHash: ComponentHash,
): Promise<Uint8Array> {
  const proofConfigHash = await digest(
    componentHash,
    canonicalizeToBytes(proofConfig),
  );
  const documentHash = await digest(
    componentHash,
    canonicalizeToBytes(document),
  );
  const out = new Uint8Array(proofConfigHash.length + documentHash.length);
  out.set(proofConfigHash, 0);
  out.set(documentHash, proofConfigHash.length);
  return out;
}

/** Options controlling how a Data Integrity proof is attached. */
export interface AddProofOptions {
  /** The verification method id (`did:web:…#key`) clients resolve to verify. */
  readonly verificationMethod: string;
  /** Proof purpose. Defaults to `"assertionMethod"`. */
  readonly proofPurpose?: string;
  /** Proof creation time. A `Date` or an XSD dateTime string. Defaults to now. */
  readonly created?: Date | string;
}

/** A document carrying its attached Data Integrity proof. */
export type SecuredDocument = JsonObject & { proof: JsonObject };

/**
 * Attach a Data Integrity proof to `document`, returning a new secured document.
 * Any existing `proof` on the input is excluded from the signed payload (a proof
 * never signs over itself).
 */
export async function addProof(
  document: JsonObject,
  signer: Signer,
  options: AddProofOptions,
): Promise<SecuredDocument> {
  const proofConfig: JsonObject = {
    type: "DataIntegrityProof",
    cryptosuite: signer.cryptosuite,
    created: toXsdDateTime(options.created ?? new Date()),
    verificationMethod: options.verificationMethod,
    proofPurpose: options.proofPurpose ?? "assertionMethod",
  };
  // The proof config's `@context` MUST match the document's, when present.
  if (document["@context"] !== undefined) {
    proofConfig["@context"] = document["@context"];
  }

  const { proof: _existing, ...unsigned } = document;
  void _existing;

  const data = await hashData(proofConfig, unsigned, signer.componentHash);
  const signature = await crypto.subtle.sign(signer.params, signer.key, data);

  const proof: JsonObject = {
    ...proofConfig,
    proofValue: encodeMultibaseBase58btc(new Uint8Array(signature)),
  };
  return { ...unsigned, proof };
}

/** A verification method as published in a DID document. */
export interface VerificationMethod {
  readonly id: string;
  readonly type?: string;
  readonly controller?: string;
  readonly publicKeyMultibase?: string;
  readonly publicKeyJwk?: JsonWebKey;
}

/** Resolve a verification method id to its document, or `undefined` if unknown. */
export type VerificationMethodResolver = (
  id: string,
) => VerificationMethod | undefined | Promise<VerificationMethod | undefined>;

interface ImportedVerifier {
  readonly key: CryptoKey;
  readonly componentHash: ComponentHash;
  readonly params: SignVerifyParams;
}

/** Import a public verification key, requiring it to match `cryptosuite`. */
async function importVerifier(
  vm: VerificationMethod,
  cryptosuite: Cryptosuite,
): Promise<ImportedVerifier> {
  if (vm.publicKeyMultibase !== undefined) {
    if (cryptosuite !== "eddsa-jcs-2022") {
      throw new Error(
        "@dwk/vc: publicKeyMultibase (Multikey) requires the eddsa-jcs-2022 cryptosuite",
      );
    }
    const { rawPublicKey } = decodeMultikey(vm.publicKeyMultibase);
    const key = await crypto.subtle.importKey(
      "raw",
      rawPublicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return { key, componentHash: "SHA-256", params: { name: "Ed25519" } };
  }

  if (vm.publicKeyJwk !== undefined) {
    const jwk = vm.publicKeyJwk;
    if (cryptosuite === "eddsa-jcs-2022") {
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
        throw new Error("@dwk/vc: eddsa-jcs-2022 requires an Ed25519 key");
      }
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return { key, componentHash: "SHA-256", params: { name: "Ed25519" } };
    }
    // ecdsa-jcs-2019
    if (jwk.kty !== "EC" || typeof jwk.crv !== "string") {
      throw new Error("@dwk/vc: ecdsa-jcs-2019 requires an EC key");
    }
    const ec = ecParamsForCurve(jwk.crv);
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: jwk.crv },
      false,
      ["verify"],
    );
    return { key, componentHash: ec.componentHash, params: ec.params };
  }

  throw new Error(
    "@dwk/vc: verification method has neither publicKeyMultibase nor publicKeyJwk",
  );
}

/** Options for {@link verifyProof}. */
export interface VerifyProofOptions {
  /** Resolves the proof's `verificationMethod` to its public key. */
  readonly resolveVerificationMethod: VerificationMethodResolver;
  /** Required proof purpose. Defaults to `"assertionMethod"`. */
  readonly expectedProofPurpose?: string;
  /**
   * The identifier the verification method must be controlled by. Defaults to
   * the credential's own `issuer` id — the correct binding for an
   * `assertionMethod` proof. Override only for proof purposes bound to a
   * different party (e.g. a presentation's `authentication` proof, bound to the
   * holder).
   */
  readonly expectedController?: string;
}

/** The issuer id of a document, whether `issuer` is a string or an `{ id }`. */
function documentIssuerId(document: JsonObject): string | undefined {
  const issuer = document.issuer;
  if (typeof issuer === "string") return issuer;
  if (issuer !== null && typeof issuer === "object" && !Array.isArray(issuer)) {
    const id = (issuer as JsonObject).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/** The controller a verification method id implies: the id with its fragment removed. */
function controllerFromMethodId(methodId: string): string {
  const hash = methodId.indexOf("#");
  return hash === -1 ? methodId : methodId.slice(0, hash);
}

/** The outcome of verifying a document's Data Integrity proof(s). */
export interface VerifyProofResult {
  readonly verified: boolean;
  /** Stable, human-readable failure descriptions; empty when verified. */
  readonly errors: readonly string[];
}

function isJsonObject(value: JcsValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asProofArray(proof: JcsValue | undefined): JsonObject[] {
  if (proof === undefined || proof === null) return [];
  if (Array.isArray(proof)) return proof.filter(isJsonObject);
  return isJsonObject(proof) ? [proof] : [];
}

function asContextArray(context: JcsValue | undefined): JcsValue[] {
  if (context === undefined) return [];
  return Array.isArray(context) ? context : [context];
}

/**
 * Whether the document's `@context` begins with every value in the proof's
 * `@context`, in order (vc-di-eddsa §3.3.2 step 4.1). A proof without an
 * `@context` imposes no constraint. Values are compared by JCS canonical form,
 * so embedded context objects match structurally regardless of key order.
 */
function contextStartsWith(
  documentContext: JcsValue | undefined,
  proofContext: JcsValue | undefined,
): boolean {
  const proofArr = asContextArray(proofContext);
  if (proofArr.length === 0) return true;
  const docArr = asContextArray(documentContext);
  if (docArr.length < proofArr.length) return false;
  for (let i = 0; i < proofArr.length; i++) {
    if (canonicalize(proofArr[i]!) !== canonicalize(docArr[i]!)) return false;
  }
  return true;
}

async function verifySingleProof(
  document: JsonObject,
  proof: JsonObject,
  options: VerifyProofOptions,
): Promise<string | null> {
  if (proof.type !== "DataIntegrityProof") {
    return `unsupported proof type "${String(proof.type)}"`;
  }
  if (!isSupportedCryptosuite(proof.cryptosuite)) {
    return `unsupported cryptosuite "${String(proof.cryptosuite)}"`;
  }
  const expectedPurpose = options.expectedProofPurpose ?? "assertionMethod";
  if (proof.proofPurpose !== expectedPurpose) {
    return `proof purpose "${String(proof.proofPurpose)}" does not match expected "${expectedPurpose}"`;
  }
  if (typeof proof.verificationMethod !== "string") {
    return "proof is missing a string verificationMethod";
  }
  if (typeof proof.proofValue !== "string") {
    return "proof is missing a string proofValue";
  }

  // vc-di-eddsa §3.3.2 step 4.1: the secured document's `@context` MUST begin
  // with the proof's `@context` values, in order, or verification fails.
  if (!contextStartsWith(document["@context"], proof["@context"])) {
    return "document @context does not start with the proof's @context values, in order";
  }

  // Both JCS cryptosuites mandate a base58-btc (`z`) proofValue; reject any
  // other multibase encoding (e.g. base64url) rather than silently decoding it.
  if (proof.proofValue[0] !== MULTIBASE_BASE58BTC) {
    return `proofValue must be base58-btc multibase (a "${MULTIBASE_BASE58BTC}" prefix), got "${proof.proofValue[0] ?? ""}"`;
  }
  let signature: Uint8Array;
  try {
    signature = base58btcDecode(proof.proofValue.slice(1));
  } catch (error) {
    return `proofValue is not valid base58-btc: ${(error as Error).message}`;
  }

  // Bind the proof to the credential's issuer BEFORE trusting any resolved key:
  // the verification method MUST be controlled by the issuer. Without this a
  // proof naming `issuer: did:web:victim` can be signed by an attacker's own key
  // under `verificationMethod: did:web:attacker#key-0`; the resolver would fetch
  // the attacker's key, the signature would verify, and the forged credential
  // would be accepted as the victim's. The controller is the method's declared
  // `controller`, or — for foreign documents that omit it — the DID/URL portion
  // of the verification method id (its fragment stripped).
  const expectedController =
    options.expectedController ?? documentIssuerId(document);
  if (expectedController === undefined) {
    return "cannot bind proof: document has no issuer to bind the verification method to";
  }

  const vm = await options.resolveVerificationMethod(proof.verificationMethod);
  if (vm === undefined) {
    return `could not resolve verification method "${proof.verificationMethod}"`;
  }
  const controller =
    typeof vm.controller === "string"
      ? vm.controller
      : controllerFromMethodId(proof.verificationMethod);
  if (controller !== expectedController) {
    return `verification method controller "${controller}" is not the credential issuer "${expectedController}"`;
  }

  let verifier: ImportedVerifier;
  try {
    verifier = await importVerifier(vm, proof.cryptosuite);
  } catch (error) {
    return (error as Error).message;
  }

  const { proofValue: _pv, ...proofConfig } = proof;
  void _pv;
  const { proof: _existing, ...unsigned } = document;
  void _existing;

  const data = await hashData(proofConfig, unsigned, verifier.componentHash);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      verifier.params,
      verifier.key,
      signature,
      data,
    );
  } catch (error) {
    return `signature verification threw: ${(error as Error).message}`;
  }
  return ok ? null : "signature verification failed";
}

/**
 * Verify the Data Integrity proof(s) on `document`. A document with no proof, or
 * any proof that fails, yields `verified: false` with the reasons collected in
 * `errors`. Never throws — verification failures are returned, not raised.
 */
export async function verifyProof(
  document: JsonObject,
  options: VerifyProofOptions,
): Promise<VerifyProofResult> {
  const proofs = asProofArray(document.proof);
  if (proofs.length === 0) {
    return { verified: false, errors: ["document has no proof"] };
  }
  const errors: string[] = [];
  for (const proof of proofs) {
    const error = await verifySingleProof(document, proof, options);
    if (error !== null) errors.push(error);
  }
  return { verified: errors.length === 0, errors };
}
