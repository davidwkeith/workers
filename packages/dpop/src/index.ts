/**
 * `@dwk/dpop` — DPoP (RFC 9449) proof verification.
 *
 * Cross-standard reusable: plain-data inputs only, no Workers runtime
 * dependency. See `spec/packages/dpop.md`.
 */

/** Facts about the HTTP request a DPoP proof is bound to. */
export interface DpopRequestFacts {
  /** HTTP method, matched against the proof `htm` claim. */
  readonly method: string;
  /** Full request target URI, matched against the proof `htu` claim. */
  readonly url: string;
}

/** Inputs required to verify a DPoP proof. */
export interface DpopVerificationInput {
  /** The compact-serialized DPoP proof JWT. */
  readonly proof: string;
  /** The request the proof must be bound to. */
  readonly request: DpopRequestFacts;
  /**
   * The access token's confirmation thumbprint (`cnf.jkt`), when the proof is
   * presented alongside a bound access token.
   */
  readonly confirmationThumbprint?: string;
}

/** Result of a successful DPoP proof verification. */
export interface DpopVerificationResult {
  /** The verified, unique proof identifier (`jti`) for replay enforcement. */
  readonly jti: string;
  /** The JWK thumbprint of the proof key. */
  readonly thumbprint: string;
}

/**
 * Verify a DPoP proof and its binding to the request (and access token, when
 * supplied). Returns the verified `jti` so callers can enforce replay policy.
 *
 * @throws if the proof is malformed, expired, or not bound to the request/token.
 */
export function verifyDpopProof(
  _input: DpopVerificationInput,
): Promise<DpopVerificationResult> {
  throw new Error("@dwk/dpop: verifyDpopProof is not implemented yet");
}
