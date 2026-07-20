/**
 * Shared plain-data types for {@link signMessage} and {@link verifyMessage}.
 *
 * The library never touches a live HTTP object: a request (or response) is
 * described by its method, URL, and header values, so it unit-tests under Node
 * with no Workers runtime.
 */

/**
 * Asymmetric signature algorithms this library accepts, named by their RFC 9421
 * §3.3 registry identifiers.
 *
 * Symmetric (`hmac-sha256`) and unsigned (`none`) algorithms are deliberately
 * excluded: an HTTP message signature must be made by the sender's private key
 * whose public half the verifier resolves out of band.
 */
export type SignatureAlgorithm =
  | "rsa-pss-sha512"
  | "rsa-v1_5-sha256"
  | "ecdsa-p256-sha256"
  | "ecdsa-p384-sha384"
  | "ed25519";

/**
 * Wire profile.
 *
 * - `"rfc9421"` — the modern `Signature-Input` / `Signature` structured-field
 *   pair (RFC 9421).
 * - `"cavage"` — the legacy single `Signature` header from
 *   `draft-cavage-http-signatures`, still emitted across the fediverse.
 */
export type SignatureProfile = "rfc9421" | "cavage";

/**
 * A request (or response) reduced to the facts a signature is computed over.
 *
 * `headers` keys are matched case-insensitively; a value array models a field
 * that appears multiple times (its values are joined with `", "` per RFC 9421
 * §2.1).
 */
export interface HttpMessage {
  /** HTTP method, e.g. `"POST"`. */
  method: string;
  /** Absolute request URI, e.g. `"https://example.com/inbox"`. */
  url: string;
  /** Header field values, keyed by (case-insensitive) field name. */
  headers: Record<string, string | string[]>;
}

/** Stable, locale-independent failure codes returned in {@link VerifyResult.reason}. */
export type SignatureFailureReason =
  | "signature_missing"
  | "signature_input_malformed"
  | "signature_malformed"
  | "label_ambiguous"
  | "label_missing"
  | "components_malformed"
  | "alg_unsupported"
  | "keyid_missing"
  | "key_unresolved"
  | "key_alg_mismatch"
  | "key_too_small"
  | "key_invalid"
  | "covered_component_missing"
  | "required_component_missing"
  | "created_invalid"
  | "created_required"
  | "created_stale"
  | "signature_expired"
  | "signature_future"
  | "expires_invalid"
  | "signature_invalid"
  | "digest_missing"
  | "digest_unsupported"
  | "digest_mismatch";

/** Result of verifying an HTTP message signature. */
export interface VerifyResult {
  /** Whether the signature is valid. */
  valid: boolean;
  /** The profile the signature was read under, when one could be identified. */
  profile?: SignatureProfile;
  /** The signature label that was verified (RFC 9421 only). */
  label?: string;
  /** The `keyid` the signature claimed (so the caller can audit the principal). */
  keyId?: string;
  /** The covered-component identifiers, in signing order. */
  coveredComponents?: string[];
  /** The signature's `created` time (epoch seconds), if present. */
  created?: number;
  /** The signature's `expires` time (epoch seconds), if present. */
  expires?: number;
  /** Stable failure code (see {@link SignatureFailureReason}) when `valid` is false. */
  reason?: SignatureFailureReason;
}
