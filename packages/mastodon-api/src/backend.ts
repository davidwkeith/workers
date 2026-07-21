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
}
