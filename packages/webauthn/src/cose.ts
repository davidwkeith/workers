/**
 * COSE_Key (RFC 9052) → JWK conversion and the Web Crypto parameters for the
 * COSE signature algorithms a WebAuthn relying party accepts.
 *
 * Authenticators hand the relying party a credential public key as a COSE_Key
 * (an integer-keyed CBOR map) and sign assertions with a COSE algorithm
 * identifier. This module narrows that to the algorithms we support — the same
 * asymmetric set as `@dwk/dpop` (ES256/ES384, RS256/PS256) — and produces a JWK
 * plus the `importKey`/`verify` parameter objects, so verification stays on Web
 * Crypto with no external dependency.
 *
 * Web Crypto's ECDSA `verify` expects a raw `r‖s` signature, but WebAuthn EC
 * assertions are ASN.1 DER `SEQUENCE { r, s }`; {@link derToRawEcdsaSignature}
 * bridges that gap.
 */

import { bytesToBase64url } from "./encoding";

/** COSE_Key map labels (RFC 9052 §7, RFC 9053). */
const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_EC_CRV = -1;
const COSE_EC_X = -2;
const COSE_EC_Y = -3;
const COSE_RSA_N = -1;
const COSE_RSA_E = -2;

/** COSE key types we accept. */
const KTY_EC2 = 2;
const KTY_RSA = 3;

/** COSE elliptic curves (RFC 9053 §7.1). */
const CRV_P256 = 1;
const CRV_P384 = 2;
const CRV_P521 = 3;

/** COSE algorithm identifiers (the asymmetric subset we accept). */
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_ES384 = -35;
export const COSE_ALG_ES512 = -36;
export const COSE_ALG_RS256 = -257;
export const COSE_ALG_PS256 = -37;

/** Default `pubKeyCredParams`, most-preferred first: ES256 then RS256. */
export const DEFAULT_COSE_ALGORITHMS: readonly number[] = [
  COSE_ALG_ES256,
  COSE_ALG_RS256,
];

/** A credential public key extracted from a COSE_Key. */
export interface CoseKey {
  /** The public key as a JWK ready for `crypto.subtle.importKey`. */
  readonly jwk: JsonWebKey;
  /** The COSE signature algorithm identifier the key declared. */
  readonly alg: number;
}

/** Thrown when a COSE_Key is malformed or uses an unsupported algorithm. */
export class CoseError extends Error {}

function intValue(map: Map<unknown, unknown>, label: number): number | null {
  const v = map.get(label);
  return typeof v === "number" ? v : null;
}

function bytesValue(
  map: Map<unknown, unknown>,
  label: number,
): Uint8Array | null {
  const v = map.get(label);
  return v instanceof Uint8Array ? v : null;
}

function ecCurveName(crv: number): string | null {
  switch (crv) {
    case CRV_P256:
      return "P-256";
    case CRV_P384:
      return "P-384";
    case CRV_P521:
      return "P-521";
    default:
      return null;
  }
}

/** Convert a decoded COSE_Key map to a JWK plus its declared algorithm. */
export function coseToKey(map: Map<unknown, unknown>): CoseKey {
  const kty = intValue(map, COSE_KTY);
  const alg = intValue(map, COSE_ALG);
  if (kty === null || alg === null) {
    throw new CoseError("COSE_Key missing kty/alg");
  }

  if (kty === KTY_EC2) {
    const crv = intValue(map, COSE_EC_CRV);
    const x = bytesValue(map, COSE_EC_X);
    const y = bytesValue(map, COSE_EC_Y);
    if (crv === null || x === null || y === null) {
      throw new CoseError("COSE EC2 key missing crv/x/y");
    }
    const curve = ecCurveName(crv);
    if (curve === null) throw new CoseError(`unsupported COSE curve ${crv}`);
    return {
      jwk: {
        kty: "EC",
        crv: curve,
        x: bytesToBase64url(x),
        y: bytesToBase64url(y),
      },
      alg,
    };
  }

  if (kty === KTY_RSA) {
    const n = bytesValue(map, COSE_RSA_N);
    const e = bytesValue(map, COSE_RSA_E);
    if (n === null || e === null) {
      throw new CoseError("COSE RSA key missing n/e");
    }
    return {
      jwk: { kty: "RSA", n: bytesToBase64url(n), e: bytesToBase64url(e) },
      alg,
    };
  }

  throw new CoseError(`unsupported COSE kty ${kty}`);
}

interface ImportAlg {
  name: string;
  namedCurve?: string;
  hash?: string;
}
interface VerifyAlg {
  name: string;
  hash?: string;
  saltLength?: number;
}

/** Web Crypto parameters for one COSE algorithm. */
export interface CryptoParams {
  readonly importParams: ImportAlg;
  readonly verifyParams: VerifyAlg;
  /** EC algorithms carry a DER-encoded signature that needs unwrapping. */
  readonly ec: boolean;
  /** Raw `r‖s` length (one coordinate × 2) for EC; unused for RSA. */
  readonly ecSignatureBytes: number;
}

/**
 * Resolve the `importKey`/`verify` parameters for a COSE algorithm, or `null`
 * when it is outside the accepted set. The set mirrors `@dwk/dpop`: ES256/ES384
 * (ECDSA), RS256 (RSASSA-PKCS1-v1_5), PS256 (RSA-PSS).
 */
export function cryptoParamsForCoseAlg(alg: number): CryptoParams | null {
  switch (alg) {
    case COSE_ALG_ES256:
      return {
        importParams: { name: "ECDSA", namedCurve: "P-256" },
        verifyParams: { name: "ECDSA", hash: "SHA-256" },
        ec: true,
        ecSignatureBytes: 64,
      };
    case COSE_ALG_ES384:
      return {
        importParams: { name: "ECDSA", namedCurve: "P-384" },
        verifyParams: { name: "ECDSA", hash: "SHA-384" },
        ec: true,
        ecSignatureBytes: 96,
      };
    case COSE_ALG_RS256:
      return {
        importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        verifyParams: { name: "RSASSA-PKCS1-v1_5" },
        ec: false,
        ecSignatureBytes: 0,
      };
    case COSE_ALG_PS256:
      return {
        importParams: { name: "RSA-PSS", hash: "SHA-256" },
        verifyParams: { name: "RSA-PSS", saltLength: 32 },
        ec: false,
        ecSignatureBytes: 0,
      };
    default:
      return null;
  }
}

/**
 * Convert an ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` ECDSA signature to
 * the fixed-length raw `r‖s` form Web Crypto's ECDSA `verify` expects. DER
 * integers are big-endian, minimally encoded, and may carry a leading `0x00`
 * sign byte; each is left-padded (or its sign byte trimmed) to `size/2` bytes.
 *
 * @param der - the DER-encoded signature
 * @param size - the raw signature length (64 for P-256, 96 for P-384)
 * @throws CoseError if the DER structure is malformed
 */
export function derToRawEcdsaSignature(
  der: Uint8Array,
  size: number,
): Uint8Array {
  let offset = 0;
  const next = (): number => {
    if (offset >= der.length) throw new CoseError("malformed DER signature");
    return der[offset++]!;
  };

  if (next() !== 0x30) throw new CoseError("DER signature not a SEQUENCE");
  // SEQUENCE length (short form is sufficient for ECDSA signatures).
  next();

  const readInteger = (): Uint8Array => {
    if (next() !== 0x02) throw new CoseError("DER signature missing INTEGER");
    const len = next();
    const end = offset + len;
    if (end > der.length) throw new CoseError("malformed DER signature");
    let value = der.subarray(offset, end);
    offset = end;
    // Drop a leading sign byte and any over-long left padding.
    while (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
    return value;
  };

  const r = readInteger();
  const s = readInteger();
  const half = size / 2;
  if (r.length > half || s.length > half) {
    throw new CoseError("DER signature integer too large");
  }

  const raw = new Uint8Array(size);
  raw.set(r, half - r.length);
  raw.set(s, size - s.length);
  return raw;
}
