/**
 * The Micropub fetch handler: the Micropub endpoint (create/update/delete/
 * undelete + `q=config`/`q=source`/`q=syndicate-to` queries) and the R2-backed
 * media endpoint, wired to the D1 post store and `@dwk/indieauth` token
 * validation. Routing matches the request pathname against the configured
 * endpoint paths, so the handler is mountable under any prefix.
 */

import type { LogFields } from "@dwk/log";

import {
  resolveConfig,
  type MicropubConfig,
  type ResolvedConfig,
} from "./config.js";
import { MicropubLogEvent } from "./log.js";
import {
  applyUpdate,
  parseFormBody,
  parseJsonBody,
  parseUpdateOperations,
  sourceView,
  sourceListView,
  normalizeProposedVocabulary,
  validateVocabulary,
  Mf2ParseError,
  type Mf2Object,
  type MicropubCommands,
  type ParsedBody,
} from "./mf2.js";
import { parsePageRequest } from "./pagination.js";
import {
  decodeSourceListCursor,
  encodeSourceListCursor,
  hasProposedSourceFilter,
  MAX_SOURCE_FILTER_VALUES,
  parseSourceListFilters,
  SourceFilterError,
} from "./source-filters.js";
import {
  createMicropubStore,
  recordToMf2,
  type MicropubStore,
  type MicropubStoreEnv,
  type PostRecord,
} from "./store.js";
import {
  ContactValidationError,
  contactView,
  contactWrite,
  type MicropubContactStore,
} from "./contacts.js";
import {
  parseVenueSearchParams,
  VenueValidationError,
  type GeoSuggestion,
  type MicropubVenueStore,
  type Venue,
} from "./venues.js";
import { authorize, hasScope, tokenFromHeader, type AuthEnv } from "./auth.js";
import {
  createMicropubMediaStore,
  MEDIA_EXTENSIONS,
  MediaValidationError,
  mediaKeyFromUrl,
  mediaTrashKey,
  parseMediaSourceParams,
  type MediaRecord,
} from "./media.js";
import { syndicateEntry } from "./fediverse.js";

/** Cloudflare bindings required by the Micropub handler. */
export interface MicropubEnv extends MicropubStoreEnv, AuthEnv {
  /** R2 bucket backing the media endpoint. */
  readonly MEDIA: R2Bucket;
}

/** A `fetch`-compatible Worker handler. */
export type MicropubHandler = (
  request: Request,
  env: MicropubEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, DPoP, Content-Type",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

/** Reconstruct a stored post as a list item, retaining its canonical URL. */
function sourceListItem(record: PostRecord): Mf2Object {
  const mf2 = recordToMf2(record);
  return {
    ...mf2,
    properties: { ...mf2.properties, url: [record.url] },
  };
}

/** A Micropub error body (`{ error, error_description }`) at `status`. */
function error(code: string, description: string, status: number): Response {
  return json({ error: code, error_description: description }, status);
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Emit a structured event on both the logger and the metrics seam, which share
 * one event vocabulary (see `@dwk/log`): `warn` for handled-but-notable
 * rejections, `info` for normal outcomes. Honors the redaction policy — callers
 * pass only reason codes, the action verb, scopes, and counts.
 */
function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

/** Fail loudly when a required binding is absent (composition contract). */
function assertBindings(env: MicropubEnv): void {
  if (!env.MEDIA) {
    throw new Error("@dwk/micropub: missing required R2 binding `MEDIA`");
  }
  if (!env.MICROPUB_DB) {
    throw new Error("@dwk/micropub: missing required D1 binding `MICROPUB_DB`");
  }
  if (!env.AUTH_DB) {
    throw new Error(
      "@dwk/micropub: missing required D1 binding `AUTH_DB` (IndieAuth token store)",
    );
  }
  if (!env.TOKEN_SIGNING_KEY || typeof env.TOKEN_SIGNING_KEY !== "string") {
    throw new Error(
      "@dwk/micropub: missing required secret binding `TOKEN_SIGNING_KEY`",
    );
  }
}

/** Acceptable scopes for each action verb. */
function scopesForAction(action: string): readonly string[] {
  switch (action) {
    case "create":
      return ["create", "post"];
    case "update":
      return ["update"];
    case "delete":
      return ["delete"];
    case "undelete":
      return ["undelete", "delete"];
    default:
      return [];
  }
}

/** Resolve a possibly-relative generated post URL against the endpoint origin. */
export function absoluteUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

/**
 * Upper bound on `q=category` results, regardless of the requested `limit`.
 * Set high because this is an autocomplete *tag list*, not a paginated feed —
 * a client generally wants every tag so it can filter locally.
 */
const MAX_CATEGORY_LIMIT = 1000;

/**
 * Parse the `limit` query parameter (the stable Limit extension) for
 * `q=category`: a positive integer, capped at {@link MAX_CATEGORY_LIMIT}. An
 * absent or malformed value yields `undefined` — i.e. the full (capped) list —
 * because a tag list for autocomplete has no useful small default page size.
 *
 * This is a *deliberate* divergence from the forthcoming post-list query
 * (`q=source` with no `url`, #351/#353), whose pagination defaults a malformed
 * `limit` to a small page: a tag list and a post feed want different defaults.
 * Both share the same philosophy — a malformed `limit` never 400s, it is a
 * client convenience, not a contract.
 */
function parseLimitParam(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, MAX_CATEGORY_LIMIT);
}

function contactsEnabled(config: ResolvedConfig): boolean {
  return config.extensions.proposed && config.contacts !== undefined;
}

function venuesEnabled(config: ResolvedConfig): boolean {
  return config.extensions.proposed && config.venues !== undefined;
}

function contactInternalUrl(config: ResolvedConfig, id: string): string {
  return `${config.micropubEndpoint.replace(/\/$/, "")}/contacts/${encodeURIComponent(id)}`;
}

function contactIdFromUrl(raw: string, config: ResolvedConfig): string | null {
  try {
    const target = new URL(raw);
    const endpoint = new URL(config.micropubEndpoint);
    const prefix = `${endpoint.pathname.replace(/\/$/, "")}/contacts/`;
    if (
      target.origin !== endpoint.origin ||
      !target.pathname.startsWith(prefix) ||
      target.search ||
      target.hash
    )
      return null;
    const encoded = target.pathname.slice(prefix.length);
    return encoded && !encoded.includes("/")
      ? decodeURIComponent(encoded)
      : null;
  } catch {
    return null;
  }
}

function parseContactPage(params: URLSearchParams): {
  filter?: string;
  limit: number;
  offset: number;
} {
  const allowed = new Set(["q", "filter", "search", "limit", "offset"]);
  for (const key of params.keys()) {
    if (!allowed.has(key))
      throw new ContactValidationError(
        `unsupported contact query parameter \`${key}\``,
      );
  }
  const one = (name: string): string | null => {
    const values = params.getAll(name);
    if (values.length > 1)
      throw new ContactValidationError(`\`${name}\` must not be repeated`);
    return values[0] ?? null;
  };
  if (params.getAll("q").length !== 1)
    throw new ContactValidationError("`q` must be supplied exactly once");
  const filter = one("filter");
  const search = one("search");
  if (filter !== null && search !== null)
    throw new ContactValidationError(
      "`filter` and `search` cannot be combined",
    );
  const limit = one("limit");
  const offset = one("offset");
  if (
    limit !== null &&
    (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
  ) {
    throw new ContactValidationError(
      "`limit` must be a base-10 integer from 1 to 100",
    );
  }
  if (
    offset !== null &&
    (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)))
  ) {
    throw new ContactValidationError(
      "`offset` must be a non-negative base-10 integer",
    );
  }
  const selected = filter ?? search;
  return {
    ...(selected ? { filter: selected.normalize("NFKC").toLowerCase() } : {}),
    limit: limit === null ? 100 : Number(limit),
    offset: offset === null ? 0 : Number(offset),
  };
}

// --- Body parsing -----------------------------------------------------------

/**
 * Whether a request's declared `Content-Length` exceeds `limit`. Used to reject
 * oversized uploads *before* `formData()` reads the whole body into memory; a
 * missing or unparseable header falls through to the post-parse `file.size`
 * guard. The header is a client claim, so it is a cheap early gate, not the
 * authoritative size check.
 */
function contentLengthExceeds(request: Request, limit: number): boolean {
  const header = request.headers.get("content-length");
  // RFC 9110: Content-Length is 1*DIGIT. Only a strictly-numeric header is a
  // usable early gate; anything else falls through to the `file.size` check.
  if (header === null || !/^\d+$/.test(header)) return false;
  const length = Number(header);
  return Number.isFinite(length) && length > limit;
}

/** Read an `application/x-www-form-urlencoded` body into `[key, value]` pairs. */
async function readForm(request: Request): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  try {
    const form = await request.formData();
    for (const [key, value] of form) {
      if (typeof value === "string") entries.push([key, value]);
    }
  } catch {
    // Malformed/empty body yields no entries; downstream validation 400s.
  }
  return entries;
}

/**
 * Parse a `multipart/form-data` create's **text** fields into a
 * {@link ParsedBody}, returning the uploaded file parts separately and
 * *unstored*. No blob ever reaches R2 here: the files are streamed to R2 only
 * after the request is authorized (see {@link handleAction} →
 * {@link foldUploadedMedia}), so an unauthenticated caller cannot cause a write.
 */
async function parseMultipartFields(
  request: Request,
  config: ResolvedConfig,
): Promise<{ parsed: ParsedBody; files: [string, File][] }> {
  // Guard memory before `formData()` buffers the whole multipart body.
  if (contentLengthExceeds(request, config.maxMediaBytes)) {
    throw new Mf2ParseError(
      `upload exceeds the ${config.maxMediaBytes}-byte limit`,
    );
  }
  const form = await request.formData();
  const textEntries: [string, string][] = [];
  const files: [string, File][] = [];
  for (const [key, value] of form) {
    if (typeof value === "string") textEntries.push([key, value]);
    else files.push([key, value]);
  }
  return { parsed: parseFormBody(textEntries), files };
}

/**
 * Stream each uploaded file to R2 and fold its URL into the matching mf2
 * property (a trailing `[]` denotes a multi-valued property, e.g. `photo[]`).
 * Called only after authorization succeeds.
 */
async function foldUploadedMedia(
  parsed: ParsedBody,
  files: [string, File][],
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<ParsedBody> {
  if (files.length === 0) return parsed;
  const properties: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(parsed.mf2.properties)) {
    properties[key] = [...values];
  }
  const storedUrls: string[] = [];
  try {
    for (const [field, file] of files) {
      if (file.size > config.maxMediaBytes) {
        throw new Mf2ParseError(
          `file "${file.name}" exceeds the ${config.maxMediaBytes}-byte limit`,
        );
      }
      const url = await storeMedia(file, env, config);
      storedUrls.push(url);
      const prop = field.endsWith("[]") ? field.slice(0, -2) : field;
      (properties[prop] ??= []).push(url);
    }
  } catch (err) {
    // A later file failed after earlier ones committed. Their URLs were never
    // returned to the client, so roll them back — otherwise a servable (and,
    // with the proposed extensions on, `q=source`-listed) orphan blob would
    // outlive a create that never happened. Best-effort: a blob that survives
    // a failed rollback is at worst an unreferenced legacy blob.
    const store = createMicropubMediaStore(env);
    for (const url of storedUrls) {
      const key = url.slice(config.mediaEndpoint.length + 1);
      try {
        await env.MEDIA.delete(key);
      } catch {
        // Best-effort.
      }
      try {
        await store.remove(key);
      } catch {
        // Best-effort.
      }
    }
    throw err;
  }
  return { ...parsed, mf2: { type: parsed.mf2.type, properties } };
}

// --- Media ------------------------------------------------------------------

/**
 * Content types safe to serve inline with their declared type — the media this
 * endpoint exists for. Anything else (notably `text/html`, `image/svg+xml`, …)
 * is served as an opaque `application/octet-stream` attachment so a `media`-scope
 * client cannot upload active content that renders as stored XSS on this origin.
 */
const SAFE_INLINE_TYPES = new Set(Object.keys(MEDIA_EXTENSIONS));

/**
 * The `micropub_media` metadata insert failed after a successful R2 write
 * while the proposed media extensions are on — the row is load-bearing for
 * `q=source`, so the fresh blob was rolled back and the request must fail.
 */
class MediaMetadataError extends Error {}

/**
 * Stream a file to R2 under a random key and return its public media URL.
 *
 * Every stored blob also gets a `micropub_media` metadata row, regardless of
 * `extensions.proposed` (invisible to clients; avoids a listing history gap
 * when a deployment later opts in). Failure handling splits by enablement:
 * enabled, the row is load-bearing for `q=source`, so an insert failure rolls
 * the blob back and throws {@link MediaMetadataError}; disabled, the insert
 * is best-effort — the upload keeps today's R2-write-succeeds guarantee and
 * the unrecorded blob simply behaves as a legacy blob later.
 */
async function storeMedia(
  file: File,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<string> {
  const ext = MEDIA_EXTENSIONS[file.type] ?? "";
  const key = `${crypto.randomUUID()}${ext}`;
  const contentType = file.type || "application/octet-stream";
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType },
  });
  try {
    await createMicropubMediaStore(env).record({
      key,
      contentType,
      sizeBytes: file.size,
      now: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    if (config.extensions.proposed) {
      config.logger.error(MicropubLogEvent.MediaMetadataFailed, {
        reason: err instanceof Error ? err.message : String(err),
      });
      try {
        await env.MEDIA.delete(key);
      } catch {
        // Best-effort rollback; the orphaned blob is unlisted either way.
      }
      throw new MediaMetadataError(
        "failed to record media metadata; the upload was rolled back",
      );
    }
    emit(config, "warn", MicropubLogEvent.MediaMetadataFailed, {});
  }
  return `${config.mediaEndpoint}/${key}`;
}

/** Handle `POST` to the media endpoint: authorize, then store the upload. */
async function handleMediaUpload(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<Response> {
  // Least privilege: the media endpoint requires the dedicated `media` scope.
  // A `create`-only token authorizes creating posts (including photos folded
  // into a multipart create), not arbitrary blob uploads to the media endpoint
  // — `q=config` advertises `media` as a distinct scope.
  const auth = await authorize(
    request,
    env,
    config,
    tokenFromHeader(request),
    ["media"],
    config.mediaEndpoint,
  );
  if (!auth.ok) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
    return error(auth.error, auth.description, auth.status);
  }

  // Reject oversized uploads before `formData()` buffers the whole body.
  if (contentLengthExceeds(request, config.maxMediaBytes)) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "media_too_large",
    });
    return error(
      "invalid_request",
      `file exceeds the ${config.maxMediaBytes}-byte limit`,
      413,
    );
  }

  const files: File[] = [];
  try {
    const form = await request.formData();
    for (const [key, value] of form) {
      if (key === "file" && typeof value !== "string") files.push(value);
    }
  } catch {
    // fall through to the missing-file error below.
  }
  const file = files[0];
  if (!file) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "media_missing",
    });
    return error(
      "invalid_request",
      "a `file` part is required at the media endpoint",
      400,
    );
  }
  if (file.size > config.maxMediaBytes) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "media_too_large",
    });
    return error(
      "invalid_request",
      `file exceeds the ${config.maxMediaBytes}-byte limit`,
      413,
    );
  }
  let url: string;
  try {
    url = await storeMedia(file, env, config);
  } catch (err) {
    if (err instanceof MediaMetadataError) {
      return error("server_error", err.message, 500);
    }
    throw err;
  }
  emit(config, "info", MicropubLogEvent.MediaStored, {
    contentType: file.type || "application/octet-stream",
  });
  if (config.extensions.proposed) {
    await pruneExpiredMediaRows(env, config);
    // Upstream Response-from-Media-Endpoint minimum: mirror the authoritative
    // `Location` header in a JSON body so clients need not read headers.
    return new Response(JSON.stringify({ url }), {
      status: 201,
      headers: {
        location: url,
        "content-type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }
  return new Response(null, {
    status: 201,
    headers: { location: url, ...CORS_HEADERS },
  });
}

/**
 * Opportunistically drop metadata rows whose trash retention has passed. The
 * blob bytes are purged by the deployment's R2 lifecycle rule on the trash
 * prefix; expired rows are excluded from every response either way, so this
 * is hygiene, never correctness — failures are swallowed.
 */
async function pruneExpiredMediaRows(
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<void> {
  const cutoff =
    Math.floor(Date.now() / 1000) - config.mediaTrashRetentionDays * 86400;
  try {
    await createMicropubMediaStore(env).pruneExpired(cutoff);
  } catch {
    // Hygiene only.
  }
}

/** The interop-consensus media `q=source` item shape. */
function mediaView(
  record: MediaRecord,
  config: ResolvedConfig,
): Record<string, unknown> {
  return {
    url: `${config.mediaEndpoint}/${record.key}`,
    published: new Date(record.uploadedAt * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    mime_type: record.contentType,
  };
}

/**
 * Handle `GET` to the media endpoint (proposed extensions only): `q=source`
 * as a newest-first listing or a single-file lookup by `url`. Requires the
 * `media` scope — deliberately unlike the post endpoint's scope-less
 * `q=source`, because the listing enumerates every upload, including media
 * attached to draft, unlisted, or private posts.
 */
async function handleMediaQuery(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<Response> {
  const auth = await authorize(
    request,
    env,
    config,
    tokenFromHeader(request),
    ["media"],
    config.mediaEndpoint,
  );
  if (!auth.ok) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
    return error(auth.error, auth.description, auth.status);
  }

  const params = new URL(request.url).searchParams;
  const q = params.get("q");
  if (q !== "source") {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "query_unsupported",
    });
    return error("invalid_request", `unsupported query \`q=${q ?? ""}\``, 400);
  }

  let query;
  try {
    query = parseMediaSourceParams(params);
  } catch (err) {
    if (err instanceof MediaValidationError) {
      return error("invalid_request", err.message, 400);
    }
    throw err;
  }

  const store = createMicropubMediaStore(env);
  if ("url" in query) {
    const key = mediaKeyFromUrl(query.url, config.mediaEndpoint);
    if (!key) {
      return error(
        "invalid_request",
        "`url` does not name media owned by this endpoint",
        400,
      );
    }
    const record = await store.get(key);
    if (!record || record.deletedAt !== null) {
      // Body-code/status divergence per the missing-post convention in
      // spec/packages/micropub.md "Error responses".
      return error("invalid_request", "no media exists at that URL", 404);
    }
    return json(mediaView(record, config));
  }
  const records = await store.list(query.page);
  return json({ items: records.map((record) => mediaView(record, config)) });
}

/**
 * Handle a non-multipart `POST` to the media endpoint (proposed extensions
 * only): `action=delete` — a recoverable soft delete via the R2 trash prefix
 * — and the package-defined symmetric `action=undelete`. Each action requires
 * **both** its action scope and `media`: a `media`-only uploader token cannot
 * destroy media, and a `delete`-only post token cannot touch the media
 * endpoint.
 */
async function handleMediaAction(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<Response> {
  const auth = await authorize(
    request,
    env,
    config,
    tokenFromHeader(request),
    ["media"],
    config.mediaEndpoint,
  );
  if (!auth.ok) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
    return error(auth.error, auth.description, auth.status);
  }

  const contentType = request.headers.get("content-type") ?? "";
  let action: string | undefined;
  let url: string | undefined;
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error("invalid_request", "request body is not valid JSON", 400);
    }
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (typeof record.action === "string") action = record.action;
      if (typeof record.url === "string") url = record.url;
    }
  } else {
    for (const [key, value] of await readForm(request)) {
      if (key === "action") action ??= value;
      if (key === "url") url ??= value;
    }
  }

  if (action !== "delete" && action !== "undelete") {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "action_unsupported",
    });
    return error(
      "invalid_request",
      `unsupported media action \`${action ?? ""}\``,
      400,
    );
  }
  if (!hasScope(auth.claims.scope, [action])) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: "insufficient_scope",
      status: 403,
    });
    return error(
      "insufficient_scope",
      `media \`${action}\` requires both the \`${action}\` and \`media\` scopes`,
      403,
    );
  }
  if (!url) {
    return error(
      "invalid_request",
      `\`url\` is required for \`${action}\``,
      400,
    );
  }
  // Load-bearing ownership validation: reject anything that is not exactly
  // this endpoint's single-segment generator-format key — before any storage
  // access.
  const key = mediaKeyFromUrl(url, config.mediaEndpoint);
  if (!key) {
    return error(
      "invalid_request",
      "`url` does not name media owned by this endpoint",
      400,
    );
  }

  const store = createMicropubMediaStore(env);
  const now = Math.floor(Date.now() / 1000);
  await pruneExpiredMediaRows(env, config);
  const trashKey = mediaTrashKey(key);

  if (action === "delete") {
    const live = await env.MEDIA.head(key);
    if (!live) {
      // Already deleted (recoverable) or never stored: both are 404.
      return error("invalid_request", "no media exists at that URL", 404);
    }
    // The live blob is never removed before the trash copy is durable, so no
    // partial failure can lose the bytes; a resumed delete (both blobs
    // present) skips straight to the removal.
    if (!(await env.MEDIA.head(trashKey))) {
      const body = await env.MEDIA.get(key);
      if (body) {
        await env.MEDIA.put(trashKey, body.body, {
          httpMetadata: body.httpMetadata,
        });
      }
    }
    await env.MEDIA.delete(key);
    await store.setDeleted(key, now);
    emit(config, "info", MicropubLogEvent.MediaDeleted, {});
    return noContent();
  }

  const trash = await env.MEDIA.get(trashKey);
  if (!trash) {
    // After the retention purge the deletion is permanent.
    return error(
      "invalid_request",
      "no recoverable media exists at that URL",
      404,
    );
  }
  await env.MEDIA.put(key, trash.body, { httpMetadata: trash.httpMetadata });
  await env.MEDIA.delete(trashKey);
  await store.setDeleted(key, null);
  emit(config, "info", MicropubLogEvent.MediaUndeleted, {});
  return noContent();
}

/** Serve a previously uploaded media blob from R2 (public, unauthenticated). */
async function handleMediaGet(
  key: string,
  env: MicropubEnv,
): Promise<Response> {
  // Only single-segment generator-format keys are public; in particular the
  // recoverable-delete trash prefix (`.trash/<key>`) must never be servable.
  if (!key || key.includes("/")) {
    return new Response("Not Found", { status: 404 });
  }
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // The stored content type is client-controlled (from the upload). Never let
  // the browser sniff, and only serve known media types inline; force anything
  // else (e.g. an uploaded `text/html`) to download as an opaque blob so it
  // cannot execute as script on this origin.
  headers.set("x-content-type-options", "nosniff");
  const baseType = (headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!baseType || !SAFE_INLINE_TYPES.has(baseType)) {
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", "attachment");
  }
  return new Response(object.body, { headers });
}

// --- Queries ----------------------------------------------------------------

async function handleContactQuery(
  params: URLSearchParams,
  config: ResolvedConfig,
  store: MicropubContactStore,
): Promise<Response> {
  try {
    const contacts = await store.list(parseContactPage(params));
    return json({
      contacts: contacts.map((contact) =>
        contactView(contact, contactInternalUrl(config, contact.id)),
      ),
    });
  } catch (err) {
    if (err instanceof ContactValidationError)
      return error("invalid_request", err.message, 400);
    throw err;
  }
}

/** Format a venue's coordinates as decimal strings, per common mf2 JSON. */
function venueView(venue: Venue): Record<string, unknown> {
  return {
    name: venue.name,
    latitude: venue.latitude.toFixed(6),
    longitude: venue.longitude.toFixed(6),
    url: venue.url,
    ...(venue.description ? { description: venue.description } : {}),
    ...(venue.category ? { category: venue.category } : {}),
  };
}

function geoSuggestionView(geo: GeoSuggestion): Record<string, unknown> {
  return {
    label: geo.label,
    latitude: geo.latitude.toFixed(6),
    longitude: geo.longitude.toFixed(6),
  };
}

async function handleVenueQuery(
  params: URLSearchParams,
  store: MicropubVenueStore,
): Promise<Response> {
  try {
    const query = parseVenueSearchParams(params);
    const result = await store.searchNearby(query);
    return json({
      ...(result.geo ? { geo: geoSuggestionView(result.geo) } : {}),
      venues: result.venues.map(venueView),
    });
  } catch (err) {
    if (err instanceof VenueValidationError)
      return error("invalid_request", err.message, 400);
    throw err;
  }
}

/** Handle `GET` to the Micropub endpoint: `q=config`/`source`/`syndicate-to`. */
async function handleQuery(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
  store: MicropubStore,
): Promise<Response> {
  const auth = await authorize(
    request,
    env,
    config,
    tokenFromHeader(request),
    [],
    config.micropubEndpoint,
  );
  if (!auth.ok) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
    return error(auth.error, auth.description, auth.status);
  }

  const params = new URL(request.url).searchParams;
  const q = params.get("q");

  if (q === "config") {
    // Advertise the extension queries whose maturity group is enabled, so a
    // client discovers `q=category` (stable) only when we will actually serve
    // it. `post-types` (the stable Supported Vocabulary extension) is included
    // only when configured and its group is on.
    const supportedQueries = ["source", "config", "syndicate-to"];
    if (config.extensions.stable) supportedQueries.push("category");
    if (contactsEnabled(config)) supportedQueries.push("contact");
    if (venuesEnabled(config)) supportedQueries.push("geo");
    return json({
      "media-endpoint": config.mediaEndpoint,
      "syndicate-to": await config.syndicateTo(),
      ...(config.extensions.stable && config.postTypes
        ? { "post-types": config.postTypes }
        : {}),
      ...(config.extensions.proposed
        ? {
            properties: ["audience", "location-visibility"],
            audiences: config.audiences,
            // Package-defined advertisement (the upstream media proposals
            // define none) so clients can feature-detect without probing.
            "media-endpoint-extensions": {
              q: ["source"],
              actions: ["delete", "undelete"],
            },
            "source-filters": {
              after: "whole-second RFC3339 exclusive creation-time lower bound",
              before:
                "whole-second RFC3339 exclusive creation-time upper bound",
              order: ["asc", "desc"],
              "post-type": "repeatable",
              "post-status": "repeatable",
              visibility: "repeatable",
              "property-exists[]": "repeatable",
              "property-value[name]": "repeatable exact string value",
              "max-values": MAX_SOURCE_FILTER_VALUES,
              pagination: ["offset", "cursor"],
            },
          }
        : {}),
      q: supportedQueries,
    });
  }
  if (q === "syndicate-to") {
    return json({ "syndicate-to": await config.syndicateTo() });
  }
  if (q === "category" && config.extensions.stable) {
    // Stable Category/Tag List extension: distinct tags for client
    // autocomplete, narrowable via the `filter` and `limit` parameters.
    const limit = parseLimitParam(params.get("limit"));
    const filter = params.get("filter");
    const categories = await store.listCategories({
      ...(limit !== undefined ? { limit } : {}),
      ...(filter ? { filter } : {}),
    });
    return json({ categories });
  }
  if (q === "contact" && config.extensions.proposed && config.contacts) {
    return handleContactQuery(params, config, config.contacts(env));
  }
  if (q === "geo" && config.extensions.proposed && config.venues) {
    return handleVenueQuery(params, config.venues);
  }
  if (q === "source") {
    const filter = [
      ...params.getAll("properties[]"),
      ...params.getAll("properties"),
    ];
    const url = params.get("url");
    const hasProposedFilters = hasProposedSourceFilter(params);
    if (hasProposedFilters && !config.extensions.proposed) {
      return error(
        "invalid_request",
        "proposed source-list filters are not enabled",
        400,
      );
    }
    if (url && hasProposedFilters) {
      return error(
        "invalid_request",
        "proposed source-list filters apply only when `q=source` has no `url`",
        400,
      );
    }
    if (!url) {
      const page = parsePageRequest(params);
      if (!hasProposedFilters) {
        const records = await store.listPosts(page);
        const mf2Objects = records.map(sourceListItem);
        return json(sourceListView(mf2Objects, filter));
      }
      if (params.has("cursor") && params.has("offset")) {
        return error(
          "invalid_request",
          "`cursor` and `offset` cannot be combined",
          400,
        );
      }
      let filters;
      let cursor;
      try {
        filters = parseSourceListFilters(params);
        const cursorRaw = params.get("cursor");
        cursor =
          cursorRaw === null
            ? undefined
            : decodeSourceListCursor(cursorRaw, filters);
      } catch (err) {
        if (err instanceof SourceFilterError) {
          return error("invalid_request", err.message, 400);
        }
        throw err;
      }
      const records = await store.listPosts(page, {
        filters,
        ...(cursor ? { cursor } : {}),
        lookahead: true,
      });
      const pageRecords = records.slice(0, page.limit);
      const mf2Objects = records.map(sourceListItem);
      const body = sourceListView(mf2Objects.slice(0, page.limit), filter);
      const last = pageRecords.at(-1);
      return json({
        ...body,
        ...(records.length > page.limit && last
          ? {
              "next-cursor": encodeSourceListCursor(
                { createdAt: last.createdAt, url: last.url },
                filters,
              ),
            }
          : {}),
      });
    }
    const record = await store.getPost(url);
    if (!record || record.deleted) {
      // No `not_found` code exists in the Micropub/OAuth registry, so the body
      // reuses `invalid_request` while keeping the semantically correct 404.
      // This deliberate body-code/status divergence is documented in
      // spec/packages/micropub.md "Error responses".
      return error("invalid_request", "no post exists at that URL", 404);
    }
    return json(sourceView(recordToMf2(record), filter));
  }

  emit(config, "warn", MicropubLogEvent.RequestRejected, {
    reason: "query_unsupported",
  });
  return error("invalid_request", `unsupported query \`q=${q ?? ""}\``, 400);
}

// --- Actions ----------------------------------------------------------------

/**
 * Parse a non-multipart `POST` body into a {@link ParsedBody} based on its
 * content type. `multipart/form-data` is handled directly in
 * {@link handleAction} so its file parts can be stored only after
 * authorization.
 */
async function parseRequest(request: Request): Promise<ParsedBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new Mf2ParseError("request body is not valid JSON");
    }
    return parseJsonBody(body);
  }
  return parseFormBody(await readForm(request));
}

function contactResponse(location: string): Response {
  return new Response(JSON.stringify({ _internal_url: location }), {
    status: 201,
    headers: { "content-type": "application/json", location, ...CORS_HEADERS },
  });
}

function contactUpdateHasInternalUrl(
  ops: ReturnType<typeof parseUpdateOperations>,
): boolean {
  return (
    ops.replace?._internal_url !== undefined ||
    ops.add?._internal_url !== undefined ||
    (Array.isArray(ops.delete)
      ? ops.delete.includes("_internal_url")
      : ops.delete?._internal_url !== undefined)
  );
}

async function handleContactAction(
  parsed: ParsedBody,
  rawJson: unknown,
  isJson: boolean,
  config: ResolvedConfig,
  store: MicropubContactStore,
): Promise<Response> {
  const action = parsed.action ?? "create";
  if (action === "create") {
    const mf2 =
      !isJson && parsed.url
        ? {
            type: parsed.mf2.type,
            properties: { ...parsed.mf2.properties, url: [parsed.url] },
          }
        : parsed.mf2;
    if (!mf2.type.includes("h-card")) {
      return error(
        "invalid_request",
        "a contact create must include the `h-card` microformats type",
        400,
      );
    }
    const id = crypto.randomUUID();
    try {
      if (
        (await store.create(
          contactWrite(id, mf2.properties, Math.floor(Date.now() / 1000)),
        )) === "conflict"
      ) {
        return error("invalid_request", "a contact already has that URL", 409);
      }
    } catch (err) {
      if (err instanceof ContactValidationError)
        return error("invalid_request", err.message, 400);
      throw err;
    }
    const location = contactInternalUrl(config, id);
    emit(config, "info", MicropubLogEvent.ActionCompleted, {
      action: "contact-create",
    });
    return contactResponse(location);
  }
  if (!parsed.url)
    return error(
      "invalid_request",
      "`url` is required for contact updates",
      400,
    );
  const id = contactIdFromUrl(parsed.url, config);
  if (!id)
    return error("invalid_request", "no contact exists at that URL", 404);
  if (action === "delete") {
    if (!(await store.delete(id)))
      return error("invalid_request", "no contact exists at that URL", 404);
    emit(config, "info", MicropubLogEvent.ActionCompleted, {
      action: "contact-delete",
    });
    return noContent();
  }
  if (action !== "update")
    return error(
      "invalid_request",
      `unsupported contact action \`${action}\``,
      400,
    );
  if (!isJson)
    return error(
      "invalid_request",
      "contact `update` requests must use `application/json`",
      400,
    );
  const record = await store.get(id);
  if (!record)
    return error("invalid_request", "no contact exists at that URL", 404);
  let ops;
  try {
    ops = parseUpdateOperations(rawJson);
  } catch (err) {
    if (err instanceof Mf2ParseError)
      return error("invalid_request", err.message, 400);
    throw err;
  }
  if (contactUpdateHasInternalUrl(ops)) {
    return error(
      "invalid_request",
      "`_internal_url` is response metadata and cannot be modified",
      400,
    );
  }
  try {
    const result = await store.update(
      contactWrite(
        id,
        applyUpdate(record.properties, ops),
        Math.floor(Date.now() / 1000),
      ),
    );
    if (result === "not_found")
      return error("invalid_request", "no contact exists at that URL", 404);
    if (result === "conflict")
      return error("invalid_request", "a contact already has that URL", 409);
  } catch (err) {
    if (err instanceof ContactValidationError)
      return error("invalid_request", err.message, 400);
    throw err;
  }
  emit(config, "info", MicropubLogEvent.ActionCompleted, {
    action: "contact-update",
  });
  return noContent();
}

/** Handle `POST` to the Micropub endpoint: dispatch on the action verb. */
async function handleAction(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
  store: MicropubStore,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  // The update body needs the raw JSON for `replace`/`add`/`delete`; capture it
  // before `parseRequest` consumes the stream.
  const contentType = request.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const isMultipart = contentType.includes("multipart/form-data");
  let rawJson: unknown;
  let parsed: ParsedBody;
  // Uploaded multipart files, parsed but NOT yet stored — they are streamed to
  // R2 only after authorization succeeds, so an unauthenticated request can
  // never cause a blob write.
  let pendingFiles: [string, File][] = [];
  try {
    if (isJson) {
      try {
        rawJson = await request.clone().json();
      } catch {
        throw new Mf2ParseError("request body is not valid JSON");
      }
      parsed = parseJsonBody(rawJson);
    } else if (isMultipart) {
      const fields = await parseMultipartFields(request, config);
      parsed = fields.parsed;
      pendingFiles = fields.files;
    } else {
      parsed = await parseRequest(request);
    }
  } catch (err) {
    if (err instanceof Mf2ParseError) {
      emit(config, "warn", MicropubLogEvent.RequestRejected, {
        reason: "invalid_body",
      });
      return error("invalid_request", err.message, 400);
    }
    throw err;
  }

  const action = parsed.action ?? "create";
  const isContactRequest =
    new URL(request.url).searchParams.get("q") === "contact";

  // RFC 6750 §2: a client MUST NOT use more than one method to transmit the
  // token. Reject — before authorizing — when the token is present in BOTH the
  // `Authorization` header and the request body.
  const headerToken = tokenFromHeader(request);
  if (headerToken !== null && parsed.token) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "multiple_token_methods",
    });
    return error(
      "invalid_request",
      "the access token must be supplied via exactly one method, not both the `Authorization` header and the request body",
      400,
    );
  }

  const token = headerToken ?? parsed.token ?? null;
  const auth = await authorize(
    request,
    env,
    config,
    token,
    scopesForAction(action),
    config.micropubEndpoint,
  );
  if (!auth.ok) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
    return error(auth.error, auth.description, auth.status);
  }

  // Authorized: only now stream any uploaded multipart files to R2 and fold
  // their URLs into the create, including contact h-cards. (Files on a
  // non-create action are ignored, so they never produce orphaned blobs.)
  if (pendingFiles.length > 0 && action === "create") {
    try {
      parsed = await foldUploadedMedia(parsed, pendingFiles, env, config);
    } catch (err) {
      if (err instanceof Mf2ParseError) {
        emit(config, "warn", MicropubLogEvent.RequestRejected, {
          reason: "invalid_body",
        });
        return error("invalid_request", err.message, 400);
      }
      if (err instanceof MediaMetadataError) {
        return error("server_error", err.message, 500);
      }
      throw err;
    }
  }

  if (isContactRequest) {
    const contacts = config.contacts;
    if (!config.extensions.proposed || !contacts) {
      return error("invalid_request", "unsupported query `q=contact`", 400);
    }
    return handleContactAction(parsed, rawJson, isJson, config, contacts(env));
  }

  switch (action) {
    case "create":
      return doCreate(parsed.mf2, parsed.commands, config, store, waitUntil);
    case "update":
      return doUpdate(parsed.url, rawJson, isJson, config, store);
    case "delete":
      return doDelete(parsed.url, config, store);
    case "undelete":
      return doUndelete(parsed.url, config, store);
    default:
      emit(config, "warn", MicropubLogEvent.RequestRejected, {
        reason: "unknown_action",
      });
      return error("invalid_request", `unknown action \`${action}\``, 400);
  }
}

/** The outcome of {@link publishPost}: the created post's URL, or an error to report. */
export type PublishPostResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly description: string;
      readonly status: number;
    };

/**
 * Create a post: generate a unique URL, store it. Shared by the HTTP `create`
 * action ({@link doCreate}) and `@dwk/mcp`'s `micropub_publish` tool
 * (`mcp-tools.ts`), so both paths run identical slug-generation,
 * collision-retry, and persistence logic.
 */
export async function publishPost(
  mf2: Mf2Object,
  commands: MicropubCommands,
  config: ResolvedConfig,
  store: MicropubStore,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<PublishPostResult> {
  const type = mf2.type[0];
  if (!type) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "missing_type",
    });
    return {
      ok: false,
      error: "invalid_request",
      description:
        "a create request must include a microformats type (e.g. `h-entry`)",
      status: 400,
    };
  }
  // Stable Post Status / Visibility extensions: reject an unrecognised
  // `post-status`/`visibility` before persisting, so a stored post only ever
  // carries a known value. Skipped when the `stable` group is disabled, in
  // which case the properties pass through as opaque mf2.
  if (config.extensions.stable) {
    try {
      validateVocabulary(mf2.properties);
    } catch (err) {
      if (err instanceof Mf2ParseError) {
        emit(config, "warn", MicropubLogEvent.RequestRejected, {
          reason: "invalid_vocabulary",
        });
        return {
          ok: false,
          error: "invalid_request",
          description: err.message,
          status: 400,
        };
      }
      throw err;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  let properties: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(mf2.properties)) {
    properties[key] = [...values];
  }

  if (config.extensions.proposed) {
    try {
      properties = normalizeProposedVocabulary(properties, config.audienceIds);
    } catch (err) {
      if (err instanceof Mf2ParseError) {
        emit(config, "warn", MicropubLogEvent.RequestRejected, {
          reason: "invalid_vocabulary",
        });
        return {
          ok: false,
          error: "invalid_request",
          description: err.message,
          status: 400,
        };
      }
      throw err;
    }
  }

  // Resolve the configured URL policy, retrying on the rare slug collision.
  let url = absoluteUrl(
    await config.generatePostUrl(mf2, commands),
    config.micropubEndpoint,
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await store.insertPost({ url, type, properties, now });
    if (inserted) {
      emit(config, "info", MicropubLogEvent.ActionCompleted, {
        action: "create",
      });
      // Fediverse syndication (#278): when configured and requested, publish
      // the entry through `@dwk/activitypub`'s shaped-publish endpoint too.
      // Failures are logged per target, never fatal — the post is created.
      // Run it in the background via `waitUntil` when available (the HTTP
      // `create` action) so a slow/unreachable fediverse peer never delays
      // the client's response; when omitted (the MCP publish tool, which has
      // no `ExecutionContext`) fall back to awaiting it inline as before.
      if (config.fediverse && commands.syndicateTo.length > 0) {
        const syndication = syndicateEntry(
          config.fediverse,
          mf2,
          commands.syndicateTo,
          await config.syndicateTo(),
          config.logger,
        );
        if (waitUntil) {
          waitUntil(syndication);
        } else {
          await syndication;
        }
      }
      return { ok: true, url };
    }
    url = `${url}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
  }
  emit(config, "warn", MicropubLogEvent.RequestRejected, {
    reason: "url_conflict",
  });
  return {
    ok: false,
    error: "invalid_request",
    description: "could not allocate a unique URL for the post",
    status: 409,
  };
}

/** Create a post via {@link publishPost}, return `201` + `Location`. */
async function doCreate(
  mf2: Mf2Object,
  commands: MicropubCommands,
  config: ResolvedConfig,
  store: MicropubStore,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const result = await publishPost(mf2, commands, config, store, waitUntil);
  if (!result.ok) {
    return error(result.error, result.description, result.status);
  }
  return new Response(null, {
    status: 201,
    headers: { location: result.url, ...CORS_HEADERS },
  });
}

/** Apply a JSON `update` to an existing post. */
async function doUpdate(
  url: string | undefined,
  rawJson: unknown,
  isJson: boolean,
  config: ResolvedConfig,
  store: MicropubStore,
): Promise<Response> {
  if (!isJson) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "update_not_json",
    });
    return error(
      "invalid_request",
      "`update` requests must use `application/json`",
      400,
    );
  }
  if (!url) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "missing_url",
    });
    return error("invalid_request", "`url` is required for `update`", 400);
  }
  const record = await store.getPost(url);
  if (!record || record.deleted) {
    return error("invalid_request", "no post exists at that URL", 404);
  }
  let ops;
  try {
    ops = parseUpdateOperations(rawJson);
  } catch (err) {
    if (err instanceof Mf2ParseError) {
      emit(config, "warn", MicropubLogEvent.RequestRejected, {
        reason: "invalid_body",
      });
      return error("invalid_request", err.message, 400);
    }
    throw err;
  }
  let next = applyUpdate(record.properties, ops);
  // Validate the *merged* result so an update introducing a bad
  // `post-status`/`visibility` is rejected (stable group only).
  if (config.extensions.stable) {
    try {
      validateVocabulary(next);
    } catch (err) {
      if (err instanceof Mf2ParseError) {
        emit(config, "warn", MicropubLogEvent.RequestRejected, {
          reason: "invalid_vocabulary",
        });
        return error("invalid_request", err.message, 400);
      }
      throw err;
    }
  }
  if (config.extensions.proposed) {
    try {
      next = normalizeProposedVocabulary(next, config.audienceIds);
    } catch (err) {
      if (err instanceof Mf2ParseError) {
        emit(config, "warn", MicropubLogEvent.RequestRejected, {
          reason: "invalid_vocabulary",
        });
        return error("invalid_request", err.message, 400);
      }
      throw err;
    }
  }
  const updated = await store.updateProperties(
    url,
    next,
    Math.floor(Date.now() / 1000),
  );
  // The post may have been deleted between the read above and this write.
  if (!updated) {
    return error("invalid_request", "no post exists at that URL", 404);
  }
  emit(config, "info", MicropubLogEvent.ActionCompleted, { action: "update" });
  return noContent();
}

/** Soft-delete a post. */
async function doDelete(
  url: string | undefined,
  config: ResolvedConfig,
  store: MicropubStore,
): Promise<Response> {
  if (!url) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "missing_url",
    });
    return error("invalid_request", "`url` is required for `delete`", 400);
  }
  const ok = await store.setDeleted(url, true, Math.floor(Date.now() / 1000));
  if (!ok) return error("invalid_request", "no post exists at that URL", 404);
  emit(config, "info", MicropubLogEvent.ActionCompleted, { action: "delete" });
  return noContent();
}

/** Restore a soft-deleted post. */
async function doUndelete(
  url: string | undefined,
  config: ResolvedConfig,
  store: MicropubStore,
): Promise<Response> {
  if (!url) {
    emit(config, "warn", MicropubLogEvent.RequestRejected, {
      reason: "missing_url",
    });
    return error("invalid_request", "`url` is required for `undelete`", 400);
  }
  const ok = await store.setDeleted(url, false, Math.floor(Date.now() / 1000));
  if (!ok) return error("invalid_request", "no post exists at that URL", 404);
  emit(config, "info", MicropubLogEvent.ActionCompleted, {
    action: "undelete",
  });
  return noContent();
}

// --- Entry point ------------------------------------------------------------

/**
 * Create the Micropub handler. The returned handler routes by pathname against
 * the configured endpoint URLs, so it is mountable under any path prefix.
 */
export function createMicropub(config: MicropubConfig): MicropubHandler {
  const resolved = resolveConfig(config);

  return async (request, env, ctx) => {
    assertBindings(env);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Media endpoint: POST uploads (and, with the proposed extensions on,
    // form/JSON `action=delete`/`undelete` plus GET `q=source`), GET serves a
    // blob under `${mediaPath}/<key>`.
    if (pathname === resolved.mediaPath) {
      if (method === "GET" && resolved.extensions.proposed) {
        return handleMediaQuery(request, env, resolved);
      }
      if (method !== "POST") {
        return methodNotAllowed(
          resolved.extensions.proposed ? "GET, POST, OPTIONS" : "POST, OPTIONS",
        );
      }
      const contentType = request.headers.get("content-type") ?? "";
      if (
        resolved.extensions.proposed &&
        !contentType.toLowerCase().includes("multipart/form-data")
      ) {
        return handleMediaAction(request, env, resolved);
      }
      return handleMediaUpload(request, env, resolved);
    }
    if (pathname.startsWith(`${resolved.mediaPath}/`)) {
      if (method !== "GET") return methodNotAllowed("GET, OPTIONS");
      const key = pathname.slice(resolved.mediaPath.length + 1);
      return handleMediaGet(key, env);
    }

    // Micropub endpoint: GET queries, POST actions.
    if (pathname === resolved.micropubPath) {
      const store = createMicropubStore(env);
      if (method === "GET") return handleQuery(request, env, resolved, store);
      if (method === "POST") {
        // Deferred: only resolved when actually invoked (fediverse
        // syndication is requested), so a caller whose `ExecutionContext`
        // stub omits `waitUntil` — as most tests' fixtures do — never trips
        // over its absence unless it truly reaches that path.
        return handleAction(request, env, resolved, store, (p) =>
          ctx.waitUntil(p),
        );
      }
      return methodNotAllowed("GET, POST, OPTIONS");
    }

    return new Response("Not Found", { status: 404 });
  };
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow, ...CORS_HEADERS },
  });
}
