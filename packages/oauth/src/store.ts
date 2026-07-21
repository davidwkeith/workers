/**
 * Plain-data storage seams for the stateful endpoints.
 *
 * Per the design constraint, this lib does **not** own a database: token, client,
 * and pushed-request records are passed in and out through these interfaces, and
 * the consuming endpoint package backs them with a strongly-consistent store
 * (D1 with session consistency, or a Durable Object) via `@dwk/store` —
 * **never KV**, since a stale token/authz record is a security bug. Implementing
 * these against an in-memory `Map` is all a unit test needs, which is why the
 * core runs under plain Node.
 */

/**
 * The data an introspection lookup returns for a token (RFC 7662 §2.2). All
 * members are optional except what the caller chooses to expose; the handler
 * maps these camelCase fields to the snake_case response members and decides
 * `active` from `revoked`/`expiresAt` unless {@link active} is set explicitly.
 */
export interface IntrospectionTokenRecord {
  /**
   * Explicit active flag. When omitted, the handler derives liveness from
   * {@link revoked} and {@link expiresAt}; set `false` to force inactive.
   */
  readonly active?: boolean;
  /** Whether the token has been revoked — forces `active: false`. */
  readonly revoked?: boolean;
  /** Space-separated granted scopes (`scope`). */
  readonly scope?: string;
  /** The client the token was issued to (`client_id`). */
  readonly clientId?: string;
  /** Human-readable resource-owner identifier (`username`). */
  readonly username?: string;
  /** Token type, e.g. `"Bearer"` or `"DPoP"` (`token_type`). */
  readonly tokenType?: string;
  /** Expiry, seconds since the epoch (`exp`). */
  readonly expiresAt?: number;
  /** Issued-at, seconds since the epoch (`iat`). */
  readonly issuedAt?: number;
  /** Not-before, seconds since the epoch (`nbf`). */
  readonly notBefore?: number;
  /** Subject identifier (`sub`). */
  readonly subject?: string;
  /** Intended audience (`aud`). */
  readonly audience?: string | readonly string[];
  /** Issuer identifier (`iss`). */
  readonly issuer?: string;
  /** Unique token identifier (`jti`). */
  readonly tokenId?: string;
  /**
   * RFC 9449 DPoP confirmation: the proof-key thumbprint bound to the token.
   * Surfaced as `cnf: { jkt }` so a Resource Server can complete the binding.
   */
  readonly jkt?: string;
}

/** A pushed authorization request awaiting redemption (RFC 9126). */
export interface PushedRequestRecord {
  /** The opaque `request_uri` reference (without the URN prefix). */
  readonly reference: string;
  /** The client that pushed the request. */
  readonly clientId: string;
  /** The pushed authorization parameters (form fields), as key→value. */
  readonly params: Readonly<Record<string, string>>;
  /** Expiry, seconds since the epoch. */
  readonly expiresAt: number;
  /** DPoP key thumbprint, when the PAR was DPoP-bound (RFC 9449 §10). */
  readonly jkt?: string;
}

/** Storage for pushed authorization requests (RFC 9126). */
export interface PushedAuthorizationStore {
  /** Persist a freshly pushed request, keyed by its `reference`. */
  save(record: PushedRequestRecord): Promise<void>;
  /**
   * Atomically fetch and invalidate a pushed request by `reference`, returning
   * it only if it was still present and unexpired at `now`. Returns `null`
   * otherwise, so a `request_uri` is single-use even under concurrent
   * authorization requests (enforce this with a conditional delete/`RETURNING`).
   */
  consume(reference: string, now: number): Promise<PushedRequestRecord | null>;
}

/** A registered OAuth client record (RFC 7591). */
export interface ClientRecord {
  /** The issued client identifier. */
  readonly clientId: string;
  /** Issued-at, seconds since the epoch (`client_id_issued_at`). */
  readonly clientIdIssuedAt: number;
  /** Hashed/opaque client secret for confidential clients, if any. */
  readonly clientSecret?: string;
  /** The validated, normalized client metadata that was registered. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Read/write storage for registered OAuth clients (RFC 7591).
 *
 * {@link ClientRegistrationConfig.saveClient} deliberately only *writes*; the
 * grant endpoints a consumer builds on top (authorize, token) need the read
 * side to verify redirect URIs and client secrets. This seam names both halves
 * so consumers implement one interface and unit-test against a `Map`.
 */
export interface ClientStore {
  /** Persist a newly registered client record. */
  saveClient(record: ClientRecord): Promise<void>;
  /** Fetch a registered client by `client_id`, or `null` when unknown. */
  getClient(clientId: string): Promise<ClientRecord | null>;
}
