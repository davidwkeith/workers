/**
 * `did:plc` operations: the genesis and rotation records that define a
 * PLC-rooted account in the public [PLC directory](https://web.plc.directory).
 *
 * Unlike `did:web` — where identity lives entirely under the user's own origin —
 * `did:plc` anchors the DID in an external, append-only operation log. That is a
 * deliberate trade-off (a dependency on a shared directory the rest of the cohort
 * avoids), made here only because the overwhelming majority of real Bluesky
 * accounts are PLC-rooted, so hosting or migrating one in requires speaking it.
 * `did:web` remains this package's default; `did:plc` is opt-in.
 *
 * This module is the **pure, Workers-runtime-free core**: it builds, signs, and
 * derives identifiers for operations using only the existing DAG-CBOR / SHA-256 /
 * base32 primitives. Submitting operations to (and resolving them from) the
 * directory is a separate, injectable concern — see `PlcDirectory`.
 *
 * Wire format follows did:plc spec v0.1: an operation is signed over its
 * DAG-CBOR encoding **without** the `sig` field; the signature is the low-S
 * 64-byte `r‖s` from the rotation key, base64url-encoded **without padding**; and
 * the DID is `did:plc:` + the first 24 base32 chars of the SHA-256 of the signed
 * genesis operation.
 */

import { base32Encode, base64urlDecode, base64urlEncode } from "./bytes.js";
import { encodeCbor, type CborValue } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { verifyData, type Signer, type SigningCurve } from "./crypto.js";

/** A service entry in a PLC operation (e.g. the account's PDS). */
export interface PlcService {
  readonly type: string;
  readonly endpoint: string;
}

/** A PLC operation in the fields that are signed (i.e. without `sig`). */
export interface UnsignedPlcOperation {
  readonly type: "plc_operation";
  /** Rotation `did:key`s authorised to sign the next operation (1–5). */
  readonly rotationKeys: readonly string[];
  /** Named verification `did:key`s; `atproto` is the repo signing key. */
  readonly verificationMethods: Readonly<Record<string, string>>;
  /** URIs the DID is also known as, e.g. `at://<handle>` (no `#` prefix). */
  readonly alsoKnownAs: readonly string[];
  /** Named services; `atproto_pds` points at the PDS endpoint. */
  readonly services: Readonly<Record<string, PlcService>>;
  /** CID of the previous operation, or `null` for the genesis operation. */
  readonly prev: string | null;
}

/** A signed PLC operation: the signed fields plus the base64url `sig`. */
export interface SignedPlcOperation extends UnsignedPlcOperation {
  readonly sig: string;
}

/** Render an operation as a canonical CBOR value (DAG-CBOR sorts the keys). */
function opToCbor(op: UnsignedPlcOperation, sig?: string): CborValue {
  const services: Record<string, CborValue> = {};
  for (const [name, svc] of Object.entries(op.services)) {
    services[name] = { type: svc.type, endpoint: svc.endpoint };
  }
  const value: Record<string, CborValue> = {
    type: op.type,
    rotationKeys: [...op.rotationKeys],
    verificationMethods: { ...op.verificationMethods },
    alsoKnownAs: [...op.alsoKnownAs],
    services,
    prev: op.prev,
  };
  if (sig !== undefined) value.sig = sig;
  return value;
}

/** Fields a rotation operation may override; unset fields carry over. */
export interface PlcOperationUpdates {
  readonly rotationKeys?: readonly string[];
  readonly verificationMethods?: Readonly<Record<string, string>>;
  readonly alsoKnownAs?: readonly string[];
  readonly services?: Readonly<Record<string, PlcService>>;
}

/**
 * Build the **next** (rotation/update) operation from the previous signed one:
 * apply {@link updates} over its fields and chain `prev` to the previous op's
 * CID. Used to re-point a `did:plc` at a new PDS (services) and signing key
 * (verificationMethods) during migration. The result still needs signing with a
 * current rotation key ({@link signPlcOperation}).
 */
export function buildRotationOperation(
  previous: UnsignedPlcOperation,
  prevCid: string,
  updates: PlcOperationUpdates = {},
): UnsignedPlcOperation {
  return {
    type: "plc_operation",
    rotationKeys: [...(updates.rotationKeys ?? previous.rotationKeys)],
    verificationMethods: {
      ...(updates.verificationMethods ?? previous.verificationMethods),
    },
    alsoKnownAs: [...(updates.alsoKnownAs ?? previous.alsoKnownAs)],
    services: { ...(updates.services ?? previous.services) },
    prev: prevCid,
  };
}

/** The canonical bytes signed for an operation: DAG-CBOR without `sig`. */
export function unsignedPlcBytes(op: UnsignedPlcOperation): Uint8Array {
  return encodeCbor(opToCbor(op));
}

/** The canonical DAG-CBOR bytes of a signed operation (used for CID/DID). */
export function signedPlcBytes(op: SignedPlcOperation): Uint8Array {
  return encodeCbor(opToCbor(op, op.sig));
}

/**
 * Sign an unsigned operation with a rotation key, attaching the base64url `sig`.
 * `sign` must produce a low-S 64-byte `r‖s` (the {@link Signer} contract).
 */
export async function signPlcOperation(
  op: UnsignedPlcOperation,
  sign: Signer,
): Promise<SignedPlcOperation> {
  const sig = base64urlEncode(await sign(unsignedPlcBytes(op)));
  return { ...op, sig };
}

/**
 * Derive the `did:plc:` identifier from a signed **genesis** operation:
 * `did:plc:` + the first 24 base32 chars of `SHA-256(DAG-CBOR(signedOp))`.
 */
export async function didPlcFromGenesis(
  op: SignedPlcOperation,
): Promise<string> {
  if (op.prev !== null) {
    throw new Error(
      "plc: a did:plc is derived only from the genesis operation (prev must be null)",
    );
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", signedPlcBytes(op) as BufferSource),
  );
  return "did:plc:" + base32Encode(digest).slice(0, 24);
}

/** The CID string of a signed operation, used as the next op's `prev`. */
export async function plcOperationCid(op: SignedPlcOperation): Promise<string> {
  return (await CID.create(DAG_CBOR_CODEC, signedPlcBytes(op))).toString();
}

/**
 * Verify an operation's signature against a rotation key's raw public key on the
 * given curve. PLC permits only secp256k1 and P-256 rotation keys.
 */
export async function verifyPlcOperation(
  op: SignedPlcOperation,
  rotationKeyRaw: Uint8Array,
  curve: SigningCurve,
): Promise<boolean> {
  // A verification predicate should return false on malformed input (e.g. a
  // non-base64url `sig` or a wrong-length key) rather than throw.
  try {
    return await verifyData(
      rotationKeyRaw,
      unsignedPlcBytes(op),
      base64urlDecode(op.sig),
      curve,
    );
  } catch {
    return false;
  }
}
