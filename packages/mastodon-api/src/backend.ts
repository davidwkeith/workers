/**
 * The plain-data backend seam `@dwk/activitypub`'s adapter implements in
 * phase 2 (spec/mastodon-client-api.md, Decision 1). Defined here so the
 * protocol core stays free of Durable Object knowledge.
 */

/** Live collection counts for the owner actor. */
export interface BackendAccountCounts {
  readonly followers: number;
  readonly following: number;
  readonly statuses: number;
}

/** Actor profile + live counts. Phase 1 uses only the counts. */
export interface BackendAccount {
  readonly counts: BackendAccountCounts;
}

export interface BackendPageQuery {
  /** Page size; clamped by the backend. */
  readonly limit: number;
  /** Exclusive upper bound (snowflake id). */
  readonly maxId?: string;
  /** Exclusive lower bound. */
  readonly sinceId?: string;
  /** Exclusive lower bound, oldest-first window. */
  readonly minId?: string;
}

/** A stored inbox row, AS2 JSON verbatim. */
export interface BackendEntry {
  /** Snowflake id (spec/mastodon-client-api.md, Decision 3). */
  readonly id: string;
  readonly activity: Record<string, unknown>;
  readonly receivedAt: number;
  readonly objectType: string | null;
  readonly relayedBy: string | null;
  /** `0` inbox or `1` owner outbox; encoded into the snowflake id. */
  readonly source?: 0 | 1;
  /** Counts cheaply derived by the DO from stored inbound interactions. */
  readonly interactions?: {
    readonly replies: number;
    readonly favourites: number;
    readonly reblogs: number;
  };
  /** Cached actor documents keyed by IRI, never fetched in a request path. */
  readonly actorProfiles?: Readonly<Record<string, BackendActorProfile>>;
  /**
   * Reply target, resolved by the backend when this entry replies to a
   * locally-held post: the target's snowflake id and its author. A reply
   * whose `inReplyTo` names a post the backend does not hold stays absent
   * (the status renders with `in_reply_to_id: null`). `authorIsOwner`
   * selects the owner account over a synthesized remote one for
   * `in_reply_to_account_id`.
   */
  readonly inReplyTo?: {
    readonly id: string;
    readonly authorIri: string | null;
    readonly authorIsOwner: boolean;
  };
  /**
   * Hydration for a bare-IRI `Announce` (boost): the boosted post's embedded
   * AS2 object, its snowflake id, and its author, resolved by the backend
   * from a locally-held copy. Absent when the boost is already embedded or
   * the boosted post is not held — the reblog then renders content-less, as
   * before.
   */
  readonly boost?: {
    readonly id: string;
    readonly authorIri: string | null;
    readonly authorIsOwner: boolean;
    readonly object: Record<string, unknown>;
  };
}

/** Safe, best-effort fields retained from a cached remote AS2 actor document. */
export interface BackendActorProfile {
  readonly actor: string;
  readonly preferredUsername?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly url?: string;
  readonly icon?: string;
  readonly image?: string;
}

export interface BackendPage<T> {
  readonly entries: readonly T[];
}

/**
 * An owner-authored status to publish (`POST /api/v1/statuses`). `status` is
 * the plain-text body the client typed; the backend renders it to the HTML an
 * AS2 `Note` carries.
 */
export interface BackendPublishInput {
  readonly status: string;
  /** Content warning (Mastodon `spoiler_text` → AS2 `summary`). */
  readonly spoilerText?: string;
  /** Mark the status sensitive (`as:sensitive`). */
  readonly sensitive?: boolean;
}

/** A pending follow request (#473) — a `followers` row awaiting the owner's `Accept`. */
export interface BackendFollowRequest {
  readonly actor: string;
  readonly addedAt: number;
}

export interface MastodonBackend {
  /** Actor profile + live counts (followers/following/statuses). */
  account(): Promise<BackendAccount>;
  /** Newest-first page of timeline entries (Create/Announce rows). */
  timeline(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /**
   * Newest-first page of the owner's own posts only (outbox/source-1 rows),
   * backing `GET /api/v1/accounts/:id/statuses` for the owner account.
   * Optional: absent backends degrade that route to a valid-but-empty page.
   */
  ownStatuses?(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Newest-first page of notification entries. */
  notifications(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Single stored entry by snowflake id. */
  entry(id: string): Promise<BackendEntry | null>;
  /** Cached remote actor profile, or null when it has not resolved yet. */
  actorProfile?(actor: string): Promise<BackendActorProfile | null>;
  /**
   * Publish an owner status and return the stored entry (source-1). Optional:
   * a backend without it leaves the write route unsupported even where the
   * deployment opted into writes. The owner bearer + `write` scope are
   * enforced by the route before this is called.
   */
  publishStatus?(input: BackendPublishInput): Promise<BackendEntry>;
  /**
   * Pending follow requests, oldest first (#473). Optional: absent backend ⇒
   * `GET /api/v1/follow_requests` answers `200 []`, matching every other
   * degrade-gracefully optional member here.
   */
  followRequests?(): Promise<readonly BackendFollowRequest[]>;
  /**
   * Authorize or reject a pending follow request (#473). Optional and
   * `allowWrites`-gated like `publishStatus` — absent backend or
   * `allowWrites` off ⇒ both write routes answer `404`.
   */
  respondToFollowRequest?(
    actor: string,
    action: "authorize" | "reject",
  ): Promise<void>;
}
