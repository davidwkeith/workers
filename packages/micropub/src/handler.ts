/**
 * The Micropub fetch handler: the Micropub endpoint (create/update/delete/
 * undelete + `q=config`/`q=source`/`q=syndicate-to` queries) and the R2-backed
 * media endpoint, wired to the D1 post store and `@dwk/indieauth` token
 * validation. Routing matches the request pathname against the configured
 * endpoint paths, so the handler is mountable under any prefix.
 */

import {
  resolveConfig,
  type MicropubConfig,
  type ResolvedConfig,
} from "./config";
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
} from "./mf2";
import {
  createMicropubStore,
  recordToMf2,
  type MicropubStore,
  type MicropubStoreEnv,
} from "./store";
import { authorize, tokenFromHeader, type AuthEnv } from "./auth";

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
function absoluteUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

// --- Body parsing -----------------------------------------------------------

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
  const auth = await authorize(request, env, config, tokenFromHeader(request), [
    "media",
    "create",
  ]);
  if (!auth.ok) return error(auth.error, auth.description, auth.status);

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
    return error(
      "invalid_request",
      "a `file` part is required at the media endpoint",
      400,
    );
  }
  if (file.size > config.maxMediaBytes) {
    return error(
      "invalid_request",
      `file exceeds the ${config.maxMediaBytes}-byte limit`,
      413,
    );
  }
  const url = await storeMedia(file, env, config);
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
  if (!auth.ok) return error(auth.error, auth.description, auth.status);

  const params = new URL(request.url).searchParams;
  const q = params.get("q");

  if (q === "config") {
    return json({
      "media-endpoint": config.mediaEndpoint,
      "syndicate-to": config.syndicateTo,
      q: ["source", "config", "syndicate-to"],
    });
  }
  if (q === "syndicate-to") {
    return json({ "syndicate-to": config.syndicateTo });
  }
  if (q === "source") {
    const url = params.get("url");
    if (!url) {
      return error("invalid_request", "`url` is required for `q=source`", 400);
    }
    const record = await store.getPost(url);
    if (!record || record.deleted) {
      return error("not_found", "no post exists at that URL", 404);
    }
    const filter = [
      ...params.getAll("properties[]"),
      ...params.getAll("properties"),
    ];
    return json(sourceView(recordToMf2(record), filter));
  }

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
      return error("invalid_request", err.message, 400);
    }
    throw err;
  }

  const action = parsed.action ?? "create";
  const token = tokenFromHeader(request) ?? parsed.token ?? null;
  const auth = await authorize(
    request,
    env,
    config,
    token,
    scopesForAction(action),
  );
  if (!auth.ok) return error(auth.error, auth.description, auth.status);

  switch (action) {
    case "create":
      return doCreate(parsed.mf2, parsed.commands, config, store);
    case "update":
      return doUpdate(parsed.url, rawJson, isJson, store);
    case "delete":
      return doDelete(parsed.url, store);
    case "undelete":
      return doUndelete(parsed.url, store);
    default:
      return error("invalid_request", `unknown action \`${action}\``, 400);
  }
}

/** Create a post: generate a unique URL, store it, return `201` + `Location`. */
async function doCreate(
  mf2: Mf2Object,
  commands: MicropubCommands,
  config: ResolvedConfig,
  store: MicropubStore,
): Promise<Response> {
  const type = mf2.type[0];
  if (!type) {
    return error(
      "invalid_request",
      "a create request must include a microformats type (e.g. `h-entry`)",
      400,
    );
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
      return new Response(null, {
        status: 201,
        headers: { location: url, ...CORS_HEADERS },
      });
    }
    url = `${url}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
  }
  return error("conflict", "could not allocate a unique URL for the post", 409);
}

/** Apply a JSON `update` to an existing post. */
async function doUpdate(
  url: string | undefined,
  rawJson: unknown,
  isJson: boolean,
  store: MicropubStore,
): Promise<Response> {
  if (!isJson) {
    return error(
      "invalid_request",
      "`update` requests must use `application/json`",
      400,
    );
  }
  if (!url) {
    return error("invalid_request", "`url` is required for `update`", 400);
  }
  const record = await store.getPost(url);
  if (!record || record.deleted) {
    return error("not_found", "no post exists at that URL", 404);
  }
  let ops;
  try {
    ops = parseUpdateOperations(rawJson);
  } catch (err) {
    if (err instanceof Mf2ParseError) {
      return error("invalid_request", err.message, 400);
    }
    throw err;
  }
  const next = applyUpdate(record.properties, ops);
  await store.updateProperties(url, next, Math.floor(Date.now() / 1000));
  return noContent();
}

/** Soft-delete a post. */
async function doDelete(
  url: string | undefined,
  store: MicropubStore,
): Promise<Response> {
  if (!url) {
    return error("invalid_request", "`url` is required for `delete`", 400);
  }
  const ok = await store.setDeleted(url, true, Math.floor(Date.now() / 1000));
  if (!ok) return error("not_found", "no post exists at that URL", 404);
  return noContent();
}

/** Restore a soft-deleted post. */
async function doUndelete(
  url: string | undefined,
  store: MicropubStore,
): Promise<Response> {
  if (!url) {
    return error("invalid_request", "`url` is required for `undelete`", 400);
  }
  const ok = await store.setDeleted(url, false, Math.floor(Date.now() / 1000));
  if (!ok) return error("not_found", "no post exists at that URL", 404);
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
