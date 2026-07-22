/**
 * Mastodon entity serializers — pure functions from config/records to the
 * JSON shapes real clients require (spec/packages/mastodon-api.md lists the
 * per-field tables). Fields are built by typed extraction, never spread from
 * stored JSON: registration metadata originated with the client and must not
 * round-trip unvetted.
 */

import type { ClientRecord } from "@dwk/oauth";

import type { MastodonApiConfig } from "./config.js";
import { OWNER_ACCOUNT_ID } from "./config.js";
import type { MastodonMarkerRecord } from "./store.js";
import type { BackendAccountCounts, BackendEntry } from "./backend.js";
import { sanitizeStatusHtml } from "./sanitize.js";

/**
 * 1×1 transparent PNG. `avatar`/`header` are required by clients (some crash
 * on their absence), so unset images fall back to this self-contained URI.
 */
export const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** `client_name` / `client_uri` / `redirect_uris` via typed extraction. */
function metadataString(record: ClientRecord, field: string): string | null {
  const value = record.metadata[field];
  return typeof value === "string" ? value : null;
}

function metadataRedirectUris(record: ClientRecord): readonly string[] {
  const value = record.metadata["redirect_uris"];
  return Array.isArray(value)
    ? value.filter((uri): uri is string => typeof uri === "string")
    : [];
}

/**
 * The Mastodon `Application` entity. Pass `clientSecret` only at registration
 * time — that is the one response that may carry credentials. Never emits
 * `vapid_key` (Web Push is an explicit non-goal).
 */
export function applicationEntity(
  record: ClientRecord,
  opts?: { readonly clientSecret?: string },
): Record<string, unknown> {
  const redirectUris = metadataRedirectUris(record);
  const scope = metadataString(record, "scope") ?? "read";
  return {
    // The registration second doubles as the entity id. Two apps registered
    // in the same second collide — accepted for a single-owner instance
    // (clients key on `client_id`, not `id`, for the OAuth flow); phase 3's
    // fidelity pass (#350) is the place to revisit if the client matrix
    // ever cares.
    id: String(record.clientIdIssuedAt),
    name: metadataString(record, "client_name") ?? "",
    website: metadataString(record, "client_uri"),
    redirect_uri: redirectUris.join("\n"),
    redirect_uris: redirectUris,
    scopes: scope.split(" ").filter(Boolean),
    ...(opts?.clientSecret
      ? { client_id: record.clientId, client_secret: opts.clientSecret }
      : {}),
  };
}

/**
 * The owner's `CredentialAccount` (`GET /api/v1/accounts/verify_credentials`).
 * Counts come from the phase-2 backend when present, zeros otherwise.
 */
export function credentialAccountEntity(
  config: MastodonApiConfig,
  counts: BackendAccountCounts,
): Record<string, unknown> {
  const account = config.account;
  const note = account.note ?? "";
  const avatar = account.avatar ?? TRANSPARENT_PIXEL;
  const header = account.header ?? TRANSPARENT_PIXEL;
  return {
    id: OWNER_ACCOUNT_ID,
    username: account.username,
    acct: account.username,
    display_name: account.displayName ?? account.username,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: account.createdAt ?? "1970-01-01T00:00:00.000Z",
    note,
    url: account.url ?? `${config.baseUrl}/users/${account.username}`,
    avatar,
    avatar_static: avatar,
    header,
    header_static: header,
    followers_count: counts.followers,
    following_count: counts.following,
    statuses_count: counts.statuses,
    last_status_at: null,
    emojis: [],
    fields: [],
    source: {
      privacy: "public",
      sensitive: false,
      language: null,
      note,
      fields: [],
      follow_requests_count: 0,
    },
  };
}

/**
 * The GoToSocial-style compatibility `version` string — clients parse it for
 * feature detection, so it must lead with a Mastodon version.
 */
export function compatibilityVersion(config: MastodonApiConfig): string {
  return `4.2.0 (compatible; dwk-workers/${config.softwareVersion ?? "0"})`;
}

/**
 * The v1 `Instance` document. No `urls.streaming_api` is advertised —
 * clients fall back to polling (design non-goal).
 */
export function instanceV1Entity(
  config: MastodonApiConfig,
  host: string,
): Record<string, unknown> {
  const description = config.instance.description ?? "";
  return {
    uri: host,
    title: config.instance.title,
    short_description: description,
    description,
    email: config.instance.contactEmail ?? "",
    version: compatibilityVersion(config),
    urls: {},
    stats: { user_count: 1, status_count: 0, domain_count: 0 },
    thumbnail: config.instance.thumbnail ?? null,
    languages: config.instance.languages ?? ["en"],
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    contact_account: null,
  };
}

/** The v2 `Instance` document (same data, 4.x shape). */
export function instanceV2Entity(
  config: MastodonApiConfig,
  host: string,
): Record<string, unknown> {
  return {
    domain: host,
    title: config.instance.title,
    version: compatibilityVersion(config),
    source_url: "https://github.com/davidwkeith/workers",
    description: config.instance.description ?? "",
    usage: { users: { active_month: 1 } },
    thumbnail: { url: config.instance.thumbnail ?? null },
    languages: config.instance.languages ?? ["en"],
    configuration: {
      accounts: { max_featured_tags: 0 },
      statuses: {
        max_characters: 500,
        max_media_attachments: 4,
        characters_reserved_per_url: 23,
      },
      media_attachments: { supported_mime_types: [] },
      polls: {
        max_options: 4,
        max_characters_per_option: 50,
        min_expiration: 300,
        max_expiration: 2629746,
      },
    },
    registrations: { enabled: false, approval_required: true, message: null },
    contact: { email: config.instance.contactEmail ?? "", account: null },
    rules: [],
  };
}

/** One saved read position (`/api/v1/markers` response member). */
export function markerEntity(
  record: MastodonMarkerRecord,
): Record<string, unknown> {
  return {
    last_read_id: record.lastReadId,
    version: record.version,
    updated_at: new Date(record.updatedAt * 1000).toISOString(),
  };
}

const REMOTE_ACCOUNT_PREFIX = "r_";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Byte-safe base64url of a UTF-8 string. `btoa` throws `InvalidCharacterError`
 * on any code point above `0xFF`, and actor IRIs are attacker-controlled AS2
 * fields that may legitimately carry raw Unicode (RFC 3987 IRIs) — so this
 * goes through `TextEncoder` to bytes first rather than passing the raw
 * UTF-16 string to `btoa` directly. Mirrors the pattern in `encoding.ts`'s
 * `base64Url`, duplicated locally rather than importing (that helper isn't
 * exported and has no decode counterpart).
 */
function base64UrlEncode(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const pad =
      padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Reversible remote-account id — see Task 5's header note on why. */
export function encodeRemoteAccountId(actorIri: string): string {
  return REMOTE_ACCOUNT_PREFIX + base64UrlEncode(actorIri);
}

export function decodeRemoteAccountId(id: string): string | null {
  if (!id.startsWith(REMOTE_ACCOUNT_PREFIX)) return null;
  return base64UrlDecode(id.slice(REMOTE_ACCOUNT_PREFIX.length));
}

/** Best-effort local part from an actor IRI's path (last segment). */
function usernameFromIri(actorIri: string): string {
  try {
    const url = new URL(actorIri);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? url.hostname;
  } catch {
    return actorIri;
  }
}

/**
 * Best-effort remote `Account`, synthesized purely from the actor IRI — no
 * backend call, no outbound fetch (design doc: "no enumeration"). Embedded
 * actor-document enrichment is phase 3's actor-profile hydration cache.
 */
export function remoteAccountEntity(actorIri: string): Record<string, unknown> {
  const username = usernameFromIri(actorIri);
  let host = actorIri;
  try {
    host = new URL(actorIri).hostname;
  } catch {
    /* fall through with the raw IRI as a last resort */
  }
  return {
    id: encodeRemoteAccountId(actorIri),
    username,
    acct: `${username}@${host}`,
    display_name: username,
    locked: false,
    bot: false,
    discoverable: false,
    group: false,
    created_at: "1970-01-01T00:00:00.000Z",
    note: "",
    url: actorIri,
    avatar: TRANSPARENT_PIXEL,
    avatar_static: TRANSPARENT_PIXEL,
    header: TRANSPARENT_PIXEL,
    header_static: TRANSPARENT_PIXEL,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
}

interface RawAttachment {
  readonly type?: string;
  readonly url?: string;
  readonly mediaType?: string;
  readonly name?: string;
  readonly blurhash?: string;
}

const MEDIA_TYPE_MAP: Record<string, string> = {
  Image: "image",
  Video: "video",
  Audio: "audio",
  Document: "unknown",
};

function mediaAttachments(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter(
      (item): item is RawAttachment =>
        typeof item === "object" && item !== null,
    )
    .map((item, index) => ({
      id: String(index),
      type: MEDIA_TYPE_MAP[item.type ?? ""] ?? "unknown",
      url: item.url ?? "",
      preview_url: item.url ?? "",
      description: item.name ?? null,
      blurhash: item.blurhash ?? null,
      meta: {},
    }));
}

/**
 * `Create`/`Announce` row → `Status`. A `relayed_by` row is wrapped as a
 * reblog attributed to the relaying group's account (FEP-1b12 provenance —
 * spec/mastodon-client-api.md Decision 3's MCP-spec provenance requirement).
 */
export function statusEntity(
  entry: BackendEntry,
  opts: { readonly baseUrl: string },
): Record<string, unknown> {
  // Every field below is attacker-controlled remote-server JSON (AS2 from
  // the inbox), so each is read through a `typeof` guard with a safe
  // fallback rather than trusted at the cast's declared type — an
  // unguarded non-string/non-boolean value here must degrade to a default,
  // never propagate untyped or crash a downstream consumer (e.g.
  // `sanitizeStatusHtml`, which assumes a string).
  const activity = entry.activity as {
    readonly type?: unknown;
    readonly actor?: unknown;
    readonly object?: {
      readonly id?: unknown;
      readonly content?: unknown;
      readonly summary?: unknown;
      readonly sensitive?: unknown;
      readonly inReplyTo?: unknown;
      readonly attachment?: unknown;
      readonly published?: unknown;
    };
  };
  const actorIri = typeof activity.actor === "string" ? activity.actor : "";
  const object = activity.object ?? {};
  const content = sanitizeStatusHtml(
    typeof object.content === "string" ? object.content : "",
  );
  const objectId = typeof object.id === "string" ? object.id : null;
  const uri = objectId ?? entry.id;
  const published =
    typeof object.published === "string" ? object.published : null;
  const summary = typeof object.summary === "string" ? object.summary : "";
  const sensitive =
    typeof object.sensitive === "boolean" ? object.sensitive : false;

  const inner: Record<string, unknown> = {
    id: entry.id,
    created_at: published ?? new Date(entry.receivedAt).toISOString(),
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive,
    spoiler_text: summary,
    visibility: "public",
    language: null,
    uri,
    url: uri,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    content,
    reblog: null,
    account: actorIri
      ? remoteAccountEntity(actorIri)
      : remoteAccountEntity(opts.baseUrl),
    media_attachments: mediaAttachments(object.attachment),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  };

  if (entry.relayedBy) {
    return {
      ...inner,
      id: entry.id,
      content: "",
      spoiler_text: "",
      media_attachments: [],
      account: remoteAccountEntity(entry.relayedBy),
      reblog: inner,
    };
  }
  return inner;
}

/**
 * `Like`/`Announce`/reply-`Create` row → `Notification`, or `null` if the
 * row fits none of the phase-2 notification types (design doc: "Rows that
 * fit no type are omitted from this endpoint"). `Follow` is deliberately
 * unhandled — deferred to phase 3, not an oversight.
 */
export function notificationEntity(
  entry: BackendEntry,
  opts: { readonly baseUrl: string },
): Record<string, unknown> | null {
  // Same discipline as statusEntity: every field read off entry.activity is
  // attacker-controlled remote AS2 JSON (from the inbox of a remote
  // server), so nothing is trusted at the cast's declared type — each is
  // read through a `typeof`/`Array.isArray` guard with a safe fallback
  // before use, never propagated untyped or allowed to crash a downstream
  // consumer.
  const activity = entry.activity as {
    readonly type?: unknown;
    readonly actor?: unknown;
    readonly object?: unknown;
  };
  const type = typeof activity.type === "string" ? activity.type : "";
  const actorIri = typeof activity.actor === "string" ? activity.actor : "";
  const account = actorIri
    ? remoteAccountEntity(actorIri)
    : remoteAccountEntity(opts.baseUrl);

  if (type === "Like") {
    return {
      id: entry.id,
      type: "favourite",
      created_at: new Date(entry.receivedAt).toISOString(),
      account,
      status: null,
    };
  }
  if (type === "Announce") {
    return {
      id: entry.id,
      type: "reblog",
      created_at: new Date(entry.receivedAt).toISOString(),
      account,
      status: null,
    };
  }
  if (type === "Create") {
    const object = activity.object;
    const inReplyTo =
      object && typeof object === "object" && !Array.isArray(object)
        ? (object as Record<string, unknown>).inReplyTo
        : undefined;
    if (typeof inReplyTo === "string" && inReplyTo.startsWith(opts.baseUrl)) {
      return {
        id: entry.id,
        type: "mention",
        created_at: new Date(entry.receivedAt).toISOString(),
        account,
        status: statusEntity(entry, opts),
      };
    }
  }
  return null;
}
