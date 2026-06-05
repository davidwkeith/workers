/**
 * The WebAuthn ceremony verification core: parsing `clientDataJSON` and
 * authenticator data, then verifying a registration (attestation) and an
 * authentication (assertion) per the
 * [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/) verification
 * procedures (§7.1 and §7.2).
 *
 * These functions are **pure** and runtime-agnostic — plain-data in, result
 * out, Web Crypto the only I/O — so they unit-test in isolation and never read
 * Cloudflare bindings. The relying party state (single-use challenges, stored
 * credential records, the signature counter) lives in the Durable Object, which
 * supplies the expected values to these functions and persists what they return.
 *
 * Attestation scope: the relying party requests `attestation: "none"`, so the
 * accepted attestation statement formats are `none` and `packed` *self*
 * attestation (no `x5c`). Verifying a full attestation-certificate chain (basic
 * / AttCA attestation) is intentionally out of scope — it proves authenticator
 * provenance, which a personal-site relying party does not need. A format
 * carrying `x5c` is rejected rather than silently trusted.
 */

import { decodeFirst, CborError, type CborValue } from "./cbor";
import {
  coseToKey,
  cryptoParamsForCoseAlg,
  derToRawEcdsaSignature,
  CoseError,
} from "./cose";
import {
  bytesEqual,
  bytesToBase64url,
  bytesToUtf8,
  normalizeBase64url,
  sha256,
} from "./encoding";

/** Stable, locale-independent verification failure codes. */
export type VerifyFailureReason =
  | "client_data_malformed"
  | "client_data_type"
  | "challenge_mismatch"
  | "origin_mismatch"
  | "attestation_malformed"
  | "attestation_format_unsupported"
  | "auth_data_malformed"
  | "rp_id_mismatch"
  | "user_not_present"
  | "user_not_verified"
  | "no_credential_data"
  | "credential_key_unsupported"
  | "signature_invalid"
  | "counter_regression";

/** The decoded WebAuthn `clientDataJSON`. */
export interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin?: boolean;
}

/** Authenticator-data flag bits (WebAuthn §6.1). */
export interface AuthDataFlags {
  /** User Present. */
  readonly up: boolean;
  /** User Verified. */
  readonly uv: boolean;
  /** Attested credential data included. */
  readonly at: boolean;
  /** Extension data included. */
  readonly ed: boolean;
}

/** Parsed attested credential data (present on registration). */
export interface AttestedCredentialData {
  readonly aaguid: Uint8Array;
  readonly credentialId: Uint8Array;
  /** The credential public key, still a COSE_Key map. */
  readonly credentialPublicKey: Map<unknown, unknown>;
}

/** Parsed authenticator data (WebAuthn §6.1). */
export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: AuthDataFlags;
  readonly signCount: number;
  readonly attestedCredentialData?: AttestedCredentialData;
}

/** Parse `clientDataJSON` bytes, or `null` if it is not a valid client-data object. */
export function parseClientData(bytes: Uint8Array): ClientData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.type !== "string" ||
    typeof obj.challenge !== "string" ||
    typeof obj.origin !== "string"
  ) {
    return null;
  }
  return {
    type: obj.type,
    challenge: obj.challenge,
    origin: obj.origin,
    ...(typeof obj.crossOrigin === "boolean"
      ? { crossOrigin: obj.crossOrigin }
      : {}),
  };
}

/**
 * Parse authenticator data. The fixed header is 37 bytes (32 rpIdHash + 1 flags
 * + 4 signCount); when the AT flag is set, attested credential data follows
 * (16 aaguid + 2 credentialIdLength + L credentialId + the COSE public key).
 * Returns `null` on any structural problem.
 */
export function parseAuthenticatorData(
  bytes: Uint8Array,
): AuthenticatorData | null {
  if (bytes.length < 37) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rpIdHash = bytes.subarray(0, 32);
  const flagsByte = bytes[32]!;
  const flags: AuthDataFlags = {
    up: (flagsByte & 0x01) !== 0,
    uv: (flagsByte & 0x04) !== 0,
    at: (flagsByte & 0x40) !== 0,
    ed: (flagsByte & 0x80) !== 0,
  };
  const signCount = view.getUint32(33);

  if (!flags.at) {
    return { rpIdHash, flags, signCount };
  }

  // Attested credential data follows the fixed header.
  if (bytes.length < 55) return null;
  const aaguid = bytes.subarray(37, 53);
  const credentialIdLength = view.getUint16(53);
  const idStart = 55;
  const idEnd = idStart + credentialIdLength;
  if (idEnd > bytes.length) return null;
  const credentialId = bytes.subarray(idStart, idEnd);

  let decoded;
  try {
    decoded = decodeFirst(bytes, idEnd);
  } catch (error) {
    if (error instanceof CborError) return null;
    throw error;
  }
  if (!(decoded.value instanceof Map)) return null;

  return {
    rpIdHash,
    flags,
    signCount,
    attestedCredentialData: {
      aaguid,
      credentialId,
      credentialPublicKey: decoded.value as Map<unknown, unknown>,
    },
  };
}

/** Inputs to {@link verifyRegistration}. */
export interface RegistrationVerifyInput {
  /** The CBOR attestation object bytes. */
  readonly attestationObject: Uint8Array;
  /** The raw `clientDataJSON` bytes. */
  readonly clientDataJSON: Uint8Array;
  /** The challenge the relying party issued (base64url). */
  readonly expectedChallenge: string;
  /** Acceptable client origins. */
  readonly expectedOrigins: readonly string[];
  /** The relying party id (effective domain). */
  readonly expectedRpId: string;
  /** Whether the User Verified flag must be set. */
  readonly requireUserVerification: boolean;
}

/** A verified credential ready to persist. */
export interface VerifiedCredential {
  /** Credential id (base64url). */
  readonly id: string;
  /** Public key as a JWK. */
  readonly publicKeyJwk: JsonWebKey;
  /** COSE algorithm the key signs with. */
  readonly alg: number;
  /** Initial signature counter. */
  readonly counter: number;
  /** Authenticator AAGUID (base64url). */
  readonly aaguid: string;
}

/** Result of {@link verifyRegistration}. */
export type RegistrationVerifyResult =
  | { readonly verified: true; readonly credential: VerifiedCredential }
  | { readonly verified: false; readonly reason: VerifyFailureReason };

function reject(reason: VerifyFailureReason): {
  verified: false;
  reason: VerifyFailureReason;
} {
  return { verified: false, reason };
}

/** Shared `clientDataJSON` checks for both ceremonies. */
function checkClientData(
  clientDataJSON: Uint8Array,
  expectedType: string,
  expectedChallenge: string,
  expectedOrigins: readonly string[],
): ClientData | VerifyFailureReason {
  const clientData = parseClientData(clientDataJSON);
  if (clientData === null) return "client_data_malformed";
  if (clientData.type !== expectedType) return "client_data_type";
  if (
    normalizeBase64url(clientData.challenge) !==
    normalizeBase64url(expectedChallenge)
  ) {
    return "challenge_mismatch";
  }
  if (!expectedOrigins.includes(clientData.origin)) return "origin_mismatch";
  return clientData;
}

/** Verify a registration (attestation) ceremony (WebAuthn §7.1). */
export async function verifyRegistration(
  input: RegistrationVerifyInput,
): Promise<RegistrationVerifyResult> {
  const clientData = checkClientData(
    input.clientDataJSON,
    "webauthn.create",
    input.expectedChallenge,
    input.expectedOrigins,
  );
  if (typeof clientData === "string") return reject(clientData);

  // Decode the attestation object: { fmt, attStmt, authData }.
  let attestation: CborValue;
  try {
    attestation = decodeFirst(input.attestationObject).value;
  } catch (error) {
    if (error instanceof CborError) return reject("attestation_malformed");
    throw error;
  }
  if (!(attestation instanceof Map)) return reject("attestation_malformed");
  const fmt = attestation.get("fmt");
  const authDataBytes = attestation.get("authData");
  const attStmt = attestation.get("attStmt");
  if (typeof fmt !== "string" || !(authDataBytes instanceof Uint8Array)) {
    return reject("attestation_malformed");
  }

  const authData = parseAuthenticatorData(authDataBytes);
  if (authData === null) return reject("auth_data_malformed");

  const rpCheck = await checkRpAndFlags(authData, input);
  if (rpCheck !== null) return reject(rpCheck);

  if (!authData.attestedCredentialData) return reject("no_credential_data");

  // Resolve the credential public key from its COSE_Key.
  let coseKey;
  try {
    coseKey = coseToKey(authData.attestedCredentialData.credentialPublicKey);
  } catch (error) {
    if (error instanceof CoseError) return reject("credential_key_unsupported");
    throw error;
  }
  if (cryptoParamsForCoseAlg(coseKey.alg) === null) {
    return reject("credential_key_unsupported");
  }

  // Verify the attestation statement (none / packed self-attestation only).
  const attResult = await verifyAttestationStatement(
    fmt,
    attStmt,
    authDataBytes,
    input.clientDataJSON,
    coseKey.alg,
    coseKey.jwk,
  );
  if (attResult !== null) return reject(attResult);

  return {
    verified: true,
    credential: {
      id: bytesToBase64url(authData.attestedCredentialData.credentialId),
      publicKeyJwk: coseKey.jwk,
      alg: coseKey.alg,
      counter: authData.signCount,
      aaguid: bytesToBase64url(authData.attestedCredentialData.aaguid),
    },
  };
}

/**
 * Verify the supported attestation statement formats. Returns `null` on success
 * or a failure reason. `none` carries no statement. `packed` *self*-attestation
 * signs `authData ‖ SHA-256(clientDataJSON)` with the credential's own private
 * key, so it verifies against the just-extracted credential public key; a
 * `packed` statement carrying `x5c` (full chain) is unsupported.
 */
async function verifyAttestationStatement(
  fmt: string,
  attStmt: CborValue | undefined,
  authDataBytes: Uint8Array,
  clientDataJSON: Uint8Array,
  credentialAlg: number,
  credentialJwk: JsonWebKey,
): Promise<VerifyFailureReason | null> {
  if (fmt === "none") return null;
  if (fmt !== "packed") return "attestation_format_unsupported";
  if (!(attStmt instanceof Map)) return "attestation_malformed";
  // Full attestation-certificate chains are out of scope.
  if (attStmt.has("x5c")) return "attestation_format_unsupported";

  const alg = attStmt.get("alg");
  const sig = attStmt.get("sig");
  if (typeof alg !== "number" || !(sig instanceof Uint8Array)) {
    return "attestation_malformed";
  }
  // Self attestation MUST use the credential key's algorithm.
  if (alg !== credentialAlg) return "attestation_format_unsupported";

  const clientDataHash = await sha256(clientDataJSON);
  const signedData = concat(authDataBytes, clientDataHash);
  const ok = await verifySignature(credentialJwk, alg, sig, signedData);
  return ok ? null : "signature_invalid";
}

/** Inputs to {@link verifyAuthentication}. */
export interface AuthenticationVerifyInput {
  /** The raw authenticator data bytes. */
  readonly authenticatorData: Uint8Array;
  /** The raw `clientDataJSON` bytes. */
  readonly clientDataJSON: Uint8Array;
  /** The assertion signature bytes. */
  readonly signature: Uint8Array;
  /** The challenge the relying party issued (base64url). */
  readonly expectedChallenge: string;
  /** Acceptable client origins. */
  readonly expectedOrigins: readonly string[];
  /** The relying party id (effective domain). */
  readonly expectedRpId: string;
  /** Whether the User Verified flag must be set. */
  readonly requireUserVerification: boolean;
  /** The stored credential public key (JWK). */
  readonly credentialPublicKeyJwk: JsonWebKey;
  /** The stored credential's COSE algorithm. */
  readonly credentialAlg: number;
  /** The last signature counter recorded for this credential. */
  readonly storedCounter: number;
}

/** Result of {@link verifyAuthentication}. */
export type AuthenticationVerifyResult =
  | { readonly verified: true; readonly newCounter: number }
  | { readonly verified: false; readonly reason: VerifyFailureReason };

/** Verify an authentication (assertion) ceremony (WebAuthn §7.2). */
export async function verifyAuthentication(
  input: AuthenticationVerifyInput,
): Promise<AuthenticationVerifyResult> {
  const clientData = checkClientData(
    input.clientDataJSON,
    "webauthn.get",
    input.expectedChallenge,
    input.expectedOrigins,
  );
  if (typeof clientData === "string") return reject(clientData);

  const authData = parseAuthenticatorData(input.authenticatorData);
  if (authData === null) return reject("auth_data_malformed");

  const rpCheck = await checkRpAndFlags(authData, input);
  if (rpCheck !== null) return reject(rpCheck);

  // Signature is over authenticatorData ‖ SHA-256(clientDataJSON).
  const clientDataHash = await sha256(input.clientDataJSON);
  const signedData = concat(input.authenticatorData, clientDataHash);
  const ok = await verifySignature(
    input.credentialPublicKeyJwk,
    input.credentialAlg,
    input.signature,
    signedData,
  );
  if (!ok) return reject("signature_invalid");

  // Cloned-authenticator detection (WebAuthn §7.2 step 21): when either counter
  // is non-zero the new value MUST be strictly greater than the stored one.
  if (
    (authData.signCount !== 0 || input.storedCounter !== 0) &&
    authData.signCount <= input.storedCounter
  ) {
    return reject("counter_regression");
  }

  return { verified: true, newCounter: authData.signCount };
}

/** Verify the rpIdHash and the User Present / User Verified flags. */
async function checkRpAndFlags(
  authData: AuthenticatorData,
  input: {
    readonly expectedRpId: string;
    readonly requireUserVerification: boolean;
  },
): Promise<VerifyFailureReason | null> {
  const expectedHash = await sha256(
    new TextEncoder().encode(input.expectedRpId),
  );
  if (!bytesEqual(authData.rpIdHash, expectedHash)) return "rp_id_mismatch";
  if (!authData.flags.up) return "user_not_present";
  if (input.requireUserVerification && !authData.flags.uv) {
    return "user_not_verified";
  }
  return null;
}

/** Import a JWK for the COSE alg and verify a signature, normalizing EC DER. */
async function verifySignature(
  jwk: JsonWebKey,
  alg: number,
  signature: Uint8Array,
  signedData: Uint8Array,
): Promise<boolean> {
  const params = cryptoParamsForCoseAlg(alg);
  if (params === null) return false;
  let rawSignature = signature;
  if (params.ec) {
    try {
      rawSignature = derToRawEcdsaSignature(signature, params.ecSignatureBytes);
    } catch {
      return false;
    }
  }
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      params.importParams,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      params.verifyParams,
      key,
      rawSignature as BufferSource,
      signedData as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Concatenate two byte arrays into one. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
