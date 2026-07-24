/**
 * `createActivitypubMastodonApi` — composes `@dwk/mastodon-api`'s
 * `createMastodonApi` over this package's internal `__stats`/`__client/*` DO
 * seam (the `mcp-tools.ts`/`syndication.ts` internal-fetch pattern: a plain
 * `stub.fetch` carrying the forwarded config + internal marker, not
 * solid-pod's in-DO closures). This file is a thin translation layer only —
 * it moves rows and cursors between the two packages' shapes and carries no
 * Mastodon REST vocabulary of its own; all entity shaping lives in
 * `@dwk/mastodon-api`.
 *
 * @see spec/mastodon-client-api.md
 */

import {
  createMastodonApi,
  decodeSnowflake,
  encodeSnowflake,
  type BackendAccount,
  type BackendActorProfile,
  type BackendEntry,
  type BackendPage,
  type BackendPageQuery,
  type MastodonApiConfig,
  type MastodonApiEnv,
  type MastodonBackend,
} from "@dwk/mastodon-api";

import { objectType, type JsonValue } from "./as2.js";
import {
  INTERNAL_HEADERS,
  type ActivityPubEnv,
  type ResolvedConfig,
} from "./config.js";
import { forwardedConfig } from "./handler.js";
import type { ActivityPubObject } from "./object.js";

/** Options for {@link createActivitypubMastodonApi}. */
export interface ActivitypubMastodonApiOptions {
  readonly config: ResolvedConfig;
  readonly actor: DurableObjectNamespace<ActivityPubObject>;
  /**
   * Everything `MastodonApiConfig` needs except `backend`, which this
   * adapter supplies.
   */
  readonly mastodonConfig: Omit<MastodonApiConfig, "backend">;
}

/**
 * Wire shape of one row from `__client/timeline`, `__client/notifications`
 * (an `items` array member), and `__client/entry` (the bare object) —
 * `object.ts`'s `#listClientEntries`/`#clientEntry`. `activity` arrives
 * already `JSON.parse`d, not a raw string.
 */
interface ClientEntryRow {
  readonly seq: number;
  readonly receivedAt: number;
  readonly activity: Record<string, unknown>;
  readonly relayedBy: string | null;
  readonly source?: 0 | 1;
  readonly interactions?: BackendEntry["interactions"];
  readonly actorProfiles?: BackendEntry["actorProfiles"];
  /** Reply target resolved to a local row by the DO (`#resolveLocalObject`). */
  readonly replyTo?: {
    readonly receivedAt: number;
    readonly seq: number;
    readonly source: 0 | 1;
    readonly authorIri: string | null;
  };
  /** Boosted object hydrated from a local row by the DO (`#resolveLocalObject`). */
  readonly boost?: {
    readonly receivedAt: number;
    readonly seq: number;
    readonly source: 0 | 1;
    readonly authorIri: string | null;
    readonly object: Record<string, unknown>;
  };
}

/**
 * A DO row → `BackendEntry`. `objectType` reads the *embedded AS2 object's*
 * type (e.g. `"Note"`), not the activity's own type (e.g. `"Create"`) —
 * matching how `object.ts`'s `#classifyClientEntry` and
 * `@dwk/mastodon-api`'s entity mappers read it.
 */
function toBackendEntry(row: ClientEntryRow): BackendEntry {
  return {
    id: encodeSnowflake(row.receivedAt, row.seq, row.source ?? 0),
    activity: row.activity,
    receivedAt: row.receivedAt,
    objectType:
      objectType(row.activity.object as JsonValue | undefined) ?? null,
    relayedBy: row.relayedBy,
    source: row.source ?? 0,
    interactions: row.interactions,
    actorProfiles: row.actorProfiles,
    // Encode the DO's raw snowflake coordinates here (the DO stays codec-free,
    // like the top-level `id`); `authorIsOwner` is the source-1 (outbox) bit.
    ...(row.replyTo
      ? {
          inReplyTo: {
            id: encodeSnowflake(
              row.replyTo.receivedAt,
              row.replyTo.seq,
              row.replyTo.source,
            ),
            authorIri: row.replyTo.authorIri,
            authorIsOwner: row.replyTo.source === 1,
          },
        }
      : {}),
    ...(row.boost
      ? {
          boost: {
            id: encodeSnowflake(
              row.boost.receivedAt,
              row.boost.seq,
              row.boost.source,
            ),
            authorIri: row.boost.authorIri,
            authorIsOwner: row.boost.source === 1,
            object: row.boost.object,
          },
        }
      : {}),
  };
}

/**
 * Translate a Mastodon-shaped page query (snowflake cursors) into the DO's
 * `__client/*` query params: each of `maxId`/`sinceId`/`minId` decodes to
 * `{receivedAtMs, seqLow}`, which becomes `<prefix>_received_at` + the
 * shared source-aware same-millisecond tiebreak the DO route expects.
 */
function cursorParams(query: BackendPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit));
  const bound = (
    snowflake: string | undefined,
    prefix: "max" | "since" | "min",
  ): void => {
    if (!snowflake) return;
    const decoded = decodeSnowflake(snowflake);
    if (!decoded) return;
    params.set(`${prefix}_received_at`, String(decoded.receivedAtMs));
    params.set("tie_seq", String(decoded.seqLow));
    params.set("tie_source", String(decoded.source));
  };
  bound(query.maxId, "max");
  bound(query.sinceId, "since");
  bound(query.minId, "min");
  return params;
}

/**
 * Build the {@link MastodonBackend} implementation over this package's
 * internal DO seam. Exported (but not re-exported from `index.ts`, which
 * keeps only {@link createActivitypubMastodonApi} as the public surface) so
 * this translation layer can be exercised directly against a real DO in
 * tests, independent of which `@dwk/mastodon-api` HTTP routes have been
 * wired to consume it (timelines/notifications land in later phases).
 */
export function buildMastodonBackend(options: {
  readonly config: ResolvedConfig;
  readonly actor: DurableObjectNamespace<ActivityPubObject>;
}): MastodonBackend {
  const { config, actor } = options;

  const internalHeaders = (): Headers => {
    const headers = new Headers();
    headers.set(
      INTERNAL_HEADERS.config,
      JSON.stringify(forwardedConfig(config)),
    );
    headers.set(INTERNAL_HEADERS.internal, "1");
    return headers;
  };
  const stub = () => actor.get(actor.idFromName(config.iris.id));

  async function listEntries(
    kind: "timeline" | "notifications",
    query: BackendPageQuery,
    extraParams?: Readonly<Record<string, string>>,
  ): Promise<BackendPage<BackendEntry>> {
    const url = new URL(`${config.iris.id}/__client/${kind}`);
    for (const [key, value] of cursorParams(query)) {
      url.searchParams.set(key, value);
    }
    for (const [key, value] of Object.entries(extraParams ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await stub().fetch(
      new Request(url.toString(), { headers: internalHeaders() }),
    );
    if (!response.ok) return { entries: [] };
    const body = (await response.json()) as {
      items: ClientEntryRow[];
      combinedNewestFirst?: boolean;
    };
    const entries = body.items.map(toBackendEntry);
    // `#listClientEntries` returns rows oldest-first when the query is
    // `minId`-style (it walks forward from the lower bound), but every
    // `BackendPage.entries` consumer — `@dwk/mastodon-api`'s
    // `buildLinkHeader`, `timelines.ts`, `notifications.ts` — has a fixed
    // "always newest-first" contract regardless of which cursor selected the
    // page. Normalize here, at the DO-response boundary, so that contract
    // holds unconditionally. Key this off whether `min_received_at` actually
    // landed on the outgoing request URL, not the raw `query.minId`
    // presence: `cursorParams`'s `bound()` helper silently no-ops when
    // `decodeSnowflake` rejects the cursor (non-numeric or an
    // unsafe-integer-decoded value), in which case `#listClientEntries`
    // never took the oldest-first branch and the page arrives already
    // newest-first — reversing it would reintroduce the bug this guard
    // exists to prevent.
    if (url.searchParams.has("min_received_at") && !body.combinedNewestFirst) {
      entries.reverse();
    }
    return { entries };
  }

  return {
    async account(): Promise<BackendAccount> {
      const response = await stub().fetch(
        new Request(`${config.iris.id}/__stats`, {
          headers: internalHeaders(),
        }),
      );
      const stats = response.ok
        ? ((await response.json()) as Record<string, number>)
        : {};
      return {
        counts: {
          followers: stats.followers ?? 0,
          following: stats.following ?? 0,
          statuses: stats.statuses ?? 0,
        },
      };
    },

    timeline: (query) => listEntries("timeline", query),
    // Owner posts only (`source=1` skips the DO's inbox scan) — backs
    // `GET /api/v1/accounts/:id/statuses` for the owner account.
    ownStatuses: (query) => listEntries("timeline", query, { source: "1" }),
    notifications: (query) => listEntries("notifications", query),

    async entry(id: string): Promise<BackendEntry | null> {
      const decoded = decodeSnowflake(id);
      if (!decoded) return null;
      const url = new URL(`${config.iris.id}/__client/entry`);
      url.searchParams.set("received_at", String(decoded.receivedAtMs));
      url.searchParams.set("seq_low", String(decoded.seqLow));
      url.searchParams.set("source", String(decoded.source));
      const response = await stub().fetch(
        new Request(url.toString(), { headers: internalHeaders() }),
      );
      if (!response.ok) return null;
      const row = (await response.json()) as ClientEntryRow;
      return toBackendEntry(row);
    },

    async actorProfile(actorIri: string): Promise<BackendActorProfile | null> {
      const url = new URL(`${config.iris.id}/__client/actor`);
      url.searchParams.set("actor", actorIri);
      const response = await stub().fetch(
        new Request(url.toString(), { headers: internalHeaders() }),
      );
      if (!response.ok) return null;
      return (await response.json()) as BackendActorProfile;
    },
  };
}

/**
 * Compose `@dwk/mastodon-api`'s router over this package's internal DO seam
 * (mirrors `createSolidPodWebdav`'s *export* shape — a factory returning a
 * mountable `fetch`-compatible handler — though the data-fetch mechanism
 * itself follows `mcp-tools.ts`/`syndication.ts`, not solid-pod's in-DO
 * closures).
 */
export function createActivitypubMastodonApi(
  options: ActivitypubMastodonApiOptions,
): (
  request: Request,
  env: MastodonApiEnv & ActivityPubEnv,
  ctx: ExecutionContext,
) => Promise<Response> {
  const { config, actor, mastodonConfig } = options;
  const backend = buildMastodonBackend({ config, actor });
  return createMastodonApi({ ...mastodonConfig, backend });
}
