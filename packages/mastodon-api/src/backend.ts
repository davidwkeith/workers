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

export interface MastodonBackend {
  /** Actor profile + live counts (followers/following/statuses). */
  account(): Promise<BackendAccount>;
  /** Newest-first page of timeline entries (Create/Announce rows). */
  timeline(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Newest-first page of notification entries. */
  notifications(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Single stored entry by snowflake id. */
  entry(id: string): Promise<BackendEntry | null>;
  /** Cached remote actor profile, or null when it has not resolved yet. */
  actorProfile?(actor: string): Promise<BackendActorProfile | null>;
}
