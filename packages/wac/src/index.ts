/**
 * `@dwk/wac` — Web Access Control evaluation.
 *
 * Standard-specific helper (Solid/WAC). Plain-data inputs only: it takes ACL
 * graphs and request facts and returns a decision, so it unit-tests without a
 * Workers runtime. See `spec/packages/wac.md`.
 */

/** WAC access modes. */
export type AccessMode = "Read" | "Write" | "Append" | "Control";

/** Request facts evaluated against the effective ACL. */
export interface AccessRequest {
  /** WebID of the requesting agent, if authenticated. */
  readonly agent?: string;
  /** `Origin` header value, for `acl:origin` matching. */
  readonly origin?: string;
  /** The access mode being requested. */
  readonly mode: AccessMode;
}

/** The outcome of an access-control evaluation. */
export interface AccessDecision {
  readonly allowed: boolean;
}

/**
 * Evaluate an access request against the effective ACL graph, honoring
 * `acl:default` inheritance and the Append-vs-Write distinction.
 *
 * @throws not implemented yet.
 */
export function evaluateAccess(
  _aclGraph: unknown,
  _request: AccessRequest,
): AccessDecision {
  throw new Error("@dwk/wac: evaluateAccess is not implemented yet");
}
