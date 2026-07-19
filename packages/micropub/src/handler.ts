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
  Mf2ParseError,
  type Mf2Object,
  type MicropubCommands,
  type ParsedBody,
} from "./mf2.js";
import {
  createMicropubStore,
  recordToMf2,
  type MicropubStore,
  type MicropubStoreEnv,
} from "./store.js";
import { authorize, tokenFromHeader, type AuthEnv } from "./auth.js";
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
 * Parse a `multipart/form-data` create: text fields become mf2 properties, while
 * uploaded files (e.g. `photo`) are streamed to R2 and replaced by their URLs.
 */
async function parseMultipartCreate(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<ParsedBody> {
  // Guard memory before `formData()` buffers the whole multipart body.
  if (contentLengthExceeds(request, config.maxMediaBytes)) {
    throw new Mf2ParseError(
      `upload exceeds the ${config.maxMediaBytes}-byte limit`,
    );
  }
  const form = await request.formData();
  const textEntries: [string, string][] = [];
  const fileFields: [string, File][] = [];
  for (const [key, value] of form) {
    if (typeof value === "string") textEntries.push([key, value]);
    else fileFields.push([key, value]);
  }

  const parsed = parseFormBody(textEntries);
  if (fileFields.length === 0) return parsed;

  // Upload each file and fold its URL into the matching property (a trailing
  // `[]` denotes a multi-valued property, e.g. `photo[]`).
  const properties: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(parsed.mf2.properties)) {
    properties[key] = [...values];
  }
  for (const [field, file] of fileFields) {
    if (file.size > config.maxMediaBytes) {
      throw new Mf2ParseError(
        `file "${file.name}" exceeds the ${config.maxMediaBytes}-byte limit`,
      );
    }
    const url = await storeMedia(file, env, config);
    const prop = field.endsWith("[]") ? field.slice(0, -2) : field;
    (properties[prop] ??= []).push(url);
  }
  return { ...parsed, mf2: { type: parsed.mf2.type, properties } };
}

// --- Media ------------------------------------------------------------------

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
};

/** Stream a file to R2 under a random key and return its public media URL. */
async function storeMedia(
  file: File,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<string> {
  const ext = EXTENSIONS[file.type] ?? "";
  const key = `${crypto.randomUUID()}${ext}`;
  await env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
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
  const auth = await authorize(request, env, config, tokenFromHeader(request), [
    "media",
  ]);
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
  const url = await storeMedia(file, env, config);
  emit(config, "info", MicropubLogEvent.MediaStored, {
    contentType: file.type || "application/octet-stream",
  });
  return new Response(null, {
    status: 201,
    headers: { location: url, ...CORS_HEADERS },
  });
}

/** Serve a previously uploaded media blob from R2 (public, unauthenticated). */
async function handleMediaGet(
  key: string,
  env: MicropubEnv,
): Promise<Response> {
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}

// --- Queries ----------------------------------------------------------------

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
    return json({
      "media-endpoint": config.mediaEndpoint,
      "syndicate-to": await config.syndicateTo(),
      q: ["source", "config", "syndicate-to"],
    });
  }
  if (q === "syndicate-to") {
    return json({ "syndicate-to": await config.syndicateTo() });
  }
  if (q === "source") {
    const url = params.get("url");
    if (!url) {
      emit(config, "warn", MicropubLogEvent.RequestRejected, {
        reason: "query_missing_url",
      });
      return error("invalid_request", "`url` is required for `q=source`", 400);
    }
    const record = await store.getPost(url);
    if (!record || record.deleted) {
      // No `not_found` code exists in the Micropub/OAuth registry, so the body
      // reuses `invalid_request` while keeping the semantically correct 404.
      // This deliberate body-code/status divergence is documented in
      // spec/packages/micropub.md "Error responses".
      return error("invalid_request", "no post exists at that URL", 404);
    }
    const filter = [
      ...params.getAll("properties[]"),
      ...params.getAll("properties"),
    ];
    return json(sourceView(recordToMf2(record), filter));
  }

  emit(config, "warn", MicropubLogEvent.RequestRejected, {
    reason: "query_unsupported",
  });
  return error("invalid_request", `unsupported query \`q=${q ?? ""}\``, 400);
}

// --- Actions ----------------------------------------------------------------

/** Parse a `POST` body into a {@link ParsedBody} based on its content type. */
async function parseRequest(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
): Promise<ParsedBody> {
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
  if (contentType.includes("multipart/form-data")) {
    return parseMultipartCreate(request, env, config);
  }
  return parseFormBody(await readForm(request));
}

/** Handle `POST` to the Micropub endpoint: dispatch on the action verb. */
async function handleAction(
  request: Request,
  env: MicropubEnv,
  config: ResolvedConfig,
  store: MicropubStore,
): Promise<Response> {
  // The update body needs the raw JSON for `replace`/`add`/`delete`; capture it
  // before `parseRequest` consumes the stream.
  const contentType = request.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let rawJson: unknown;
  let parsed: ParsedBody;
  try {
    if (isJson) {
      try {
        rawJson = await request.clone().json();
      } catch {
        throw new Mf2ParseError("request body is not valid JSON");
      }
      parsed = parseJsonBody(rawJson);
    } else {
      parsed = await parseRequest(request, env, config);
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
  );
  if (!auth.ok) {
    emit(config, "warn", MicropubLogEvent.AuthRejected, {
      reason: auth.error,
      status: auth.status,
    });
    return error(auth.error, auth.description, auth.status);
  }

  switch (action) {
    case "create":
      return doCreate(parsed.mf2, parsed.commands, config, store);
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
  const now = Math.floor(Date.now() / 1000);
  const properties: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(mf2.properties)) {
    properties[key] = [...values];
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
      if (config.fediverse && commands.syndicateTo.length > 0) {
        await syndicateEntry(
          config.fediverse,
          mf2,
          commands.syndicateTo,
          await config.syndicateTo(),
          config.logger,
        );
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
): Promise<Response> {
  const result = await publishPost(mf2, commands, config, store);
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
  const next = applyUpdate(record.properties, ops);
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

  return async (request, env, _ctx) => {
    assertBindings(env);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Media endpoint: POST uploads, GET serves a blob under `${mediaPath}/<key>`.
    if (pathname === resolved.mediaPath) {
      if (method !== "POST") return methodNotAllowed("POST, OPTIONS");
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
      if (method === "POST") return handleAction(request, env, resolved, store);
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
