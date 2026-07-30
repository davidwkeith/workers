/**
 * `createWebdav` — the RFC 4918 **Class 2** verb router (spec "Verb surface").
 *
 * A stateless front door that translates WebDAV verbs into the same per-pod
 * `SolidPodObject` operations Solid uses, via the injected {@link WebdavBackend}
 * seam — so the files reached in Finder *are* the pod (spec §3). The protocol
 * machinery (verb translation, the hand-rolled bounded XML, lock enforcement,
 * the app-password auth bridge) lives here; the storage/lock/credential state
 * lives in the DO the backend fronts.
 *
 * What this handler enforces directly:
 * - **HTTPS-only** Basic auth; app-password `scope ∩ WAC` least privilege (§1).
 * - **Class 2** `LOCK`/`UNLOCK` with `423 Locked` on an unkeyed mutation (§2).
 * - **`.acl`/`.meta` are `404` to every verb** and omitted from listings (§3).
 * - Content-type inference + optional OS-litter denylist (§3).
 *
 * @see spec/packages/webdav.md
 */

import {
  resolveLockPolicy,
  type DeadProperty,
  type ResolvedLockPolicy,
  type ResourceStat,
  type WebdavBackend,
  type WebdavConfig,
  type WebdavEnv,
  type WebdavMode,
  CollectionNotEmpty,
  PreconditionFailed,
  ResourceConflict,
} from "./config.js";
import { inferContentType } from "./content-type.js";
import type { AppPasswordRecord } from "./credentials.js";
import { isHttpsRequest, parseBasicAuthorization } from "./credentials.js";
import {
  type IfList,
  parseIfHeader,
  submittedLockTokens,
} from "./if-header.js";
import { isOsLitter, DEFAULT_OS_LITTER } from "./litter.js";
import {
  effectiveTimeout,
  parseTimeoutHeader,
  type LockRecord,
  type LockScope,
} from "./locks.js";
import {
  escapeXml,
  parseXml,
  serializeFragment,
  type XmlElement,
  XmlError,
} from "./xml.js";

/** The composed request handler `createWebdav` returns. */
export type WebdavHandler = (
  request: Request,
  env: WebdavEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** DoS bounds for the small WebDAV request bodies (spec §4). */
const XML_LIMITS = { maxBytes: 256 * 1024, maxDepth: 64 } as const;

const ALL_METHODS =
  "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK";
const ROOT_METHODS =
  "OPTIONS, GET, HEAD, PUT, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK";

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  207: "Multi-Status",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  412: "Precondition Failed",
  423: "Locked",
  424: "Failed Dependency",
};

/** A `<D:status>HTTP/1.1 NNN Reason</D:status>` line. */
function statusLine(code: number): string {
  return `HTTP/1.1 ${code} ${STATUS_TEXT[code] ?? ""}`.trimEnd();
}

interface Resolved {
  readonly origin: string;
  readonly storageRoot: string;
  readonly mountPrefix: string;
  readonly lockPolicy: ResolvedLockPolicy;
  readonly litter: readonly RegExp[] | null;
  readonly now: () => number;
}

/**
 * Uppercase the hex digits of every percent-encoded triplet. RFC 3986 §2.1
 * treats `%e2` and `%E2` as the same octet, but `URL`'s parser copies an
 * already-encoded triplet through verbatim rather than normalizing its case —
 * so two requests naming the same UTF-8 segment with different encoder hex
 * casing (litmus `mkcol_over_plain` reusing `put_get_utf8_segment`'s
 * resource) resolve to different path strings and miss each other in the
 * backend's exact-match lookup. Applied to both the resolved mount
 * config (here, in {@link resolve}) and every request path (in
 * {@link pathOf}) so a percent-encoded segment in `mountPath`/`baseUrl`
 * can't itself drift out of sync with a differently-cased request path.
 */
function normalizePercentEncoding(pathname: string): string {
  return pathname.replace(/%[0-9a-fA-F]{2}/g, (triplet) =>
    triplet.toUpperCase(),
  );
}

function resolve(config: WebdavConfig): Resolved {
  const url = new URL(config.baseUrl);
  const rawMount = normalizePercentEncoding(config.mountPath ?? "/");
  const mount = rawMount.endsWith("/") ? rawMount.slice(0, -1) : rawMount;
  const rawStorageRoot = normalizePercentEncoding(url.pathname);
  const storageRoot = rawStorageRoot.endsWith("/")
    ? rawStorageRoot
    : `${rawStorageRoot}/`;
  const litter =
    config.denyOsLitter === true
      ? DEFAULT_OS_LITTER
      : Array.isArray(config.denyOsLitter)
        ? config.denyOsLitter
        : null;
  return {
    origin: url.origin,
    storageRoot,
    mountPrefix: mount,
    lockPolicy: resolveLockPolicy(config.lock),
    litter,
    now: config.now ?? Date.now,
  };
}

/** Build a Response with the standard Class 2 + transport-security headers. */
function dav(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  const h = new Headers(headers);
  h.set("DAV", "1, 2");
  h.set("MS-Author-Via", "DAV");
  h.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(body, { status, headers: h });
}

function xml(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return dav(`<?xml version="1.0" encoding="utf-8"?>\n${body}`, status, {
    "Content-Type": 'application/xml; charset="utf-8"',
    ...headers,
  });
}

function problem(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return dav(message, status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
}

/**
 * The `Allow` set advertised for `path` (the root is undeletable). The mount
 * root can surface either as `resolved.storageRoot` or — when `pathOf` strips a
 * trailing-slash mount prefix down to nothing — as a bare `/`; treat both as the
 * root so its advertised methods never include `DELETE`. (Actual root-delete
 * protection is enforced in the backend; this only keeps the header honest.)
 */
function allowFor(path: string, resolved: Resolved): string {
  return path === resolved.storageRoot || path === "/"
    ? ROOT_METHODS
    : ALL_METHODS;
}

/** A `405 Method Not Allowed` with the mandatory `Allow` header (RFC 7231). */
function methodNotAllowed(
  message: string,
  resolved: Resolved,
  path: string,
): Response {
  return problem(405, message, { Allow: allowFor(path, resolved) });
}

/** A `401` that prompts the OS client for Basic credentials. */
function unauthorized(origin: string): Response {
  return dav("Authentication required", 401, {
    "WWW-Authenticate": `Basic realm="${origin}", charset="UTF-8"`,
    "Content-Type": "text/plain; charset=utf-8",
  });
}

/** The authenticated principal resolved from a verified app password. */
interface Principal {
  readonly webid: string;
  readonly record: AppPasswordRecord;
}

export function createWebdav(config: WebdavConfig): WebdavHandler {
  const resolved = resolve(config);

  const route = async (request: Request, env: WebdavEnv): Promise<Response> => {
    // HTTPS-only: Basic credentials are refused over anything but HTTPS, ahead
    // of credential parsing (spec §1).
    if (!isHttpsRequest(request.url)) {
      return problem(403, "WebDAV requires HTTPS");
    }

    const backend = config.backend(env);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // OPTIONS advertises capabilities without authentication so the OS client
    // can discover Class 2 support before it has credentials.
    if (method === "OPTIONS") {
      const path = pathOf(url, resolved);
      return dav(null, 204, { Allow: allowFor(path ?? "", resolved) });
    }

    const principal = await authenticate(request, backend, resolved.origin);
    if (principal instanceof Response) return principal;

    const path = pathOf(url, resolved);
    if (path === null) return problem(404, "Not found");

    // Auxiliary resources are Solid control-plane, never files: every verb
    // against `.acl`/`.meta` is 404 (spec §3) — not merely hidden.
    if (isAuxiliary(path)) return problem(404, "Not found");

    // The `If:` header is parsed as a bounded grammar (spec §4): anything
    // outside it is answered `400` rather than parsed best-effort — guessing
    // here is a classic parser-differential hazard, and silently dropping a
    // conditional the client asked for would fail *open*. A parsed header is
    // a precondition (RFC 4918 §10.4.3): the request proceeds only if at
    // least one list evaluates true, else `412` (litmus `fail_cond_put_unlocked`
    // — a lock token that matches no live lock must 412 even on an unlocked
    // resource).
    const ifHeader = request.headers.get("if");
    const parsedIf = parseIfHeader(ifHeader);
    if (parsedIf.kind === "unsupported") {
      return problem(400, "Unsupported If: header");
    }
    if (
      parsedIf.kind === "lists" &&
      !(await evaluateIf(parsedIf.lists, backend, resolved, url, path))
    ) {
      return problem(412, "If: condition not satisfied");
    }

    const ctx: RequestContext = { request, url, backend, principal, path };
    switch (method) {
      case "PROPFIND":
        return propfind(ctx, resolved);
      case "PROPPATCH":
        return proppatch(ctx, resolved);
      case "GET":
      case "HEAD":
        return read(ctx, method === "HEAD");
      case "PUT":
        return put(ctx, resolved);
      case "DELETE":
        return remove(ctx, resolved);
      case "MKCOL":
        return mkcol(ctx, resolved);
      case "COPY":
      case "MOVE":
        return copyMove(ctx, resolved, method);
      case "LOCK":
        return lock(ctx, resolved);
      case "UNLOCK":
        return unlock(ctx);
      default:
        return methodNotAllowed("Method not allowed", resolved, path);
    }
  };

  return async function webdav(request, env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      // An unexpected backend exception must still answer as a well-formed
      // DAV response (every reply carries `DAV: 1, 2` etc. per spec) rather
      // than escape as a bare crash from the composing Worker.
      console.error("@dwk/webdav: unexpected error", error);
      response = problem(500, "Internal Server Error");
    }
    // A refused write (401/403/409/423 …) leaves the request body unread.
    // Consume a bounded amount before responding: this handler runs inside
    // the pod DO on a body forwarded over `stub.fetch`, and workerd's local
    // dev crashes when the forwarding pipe is first pulled after the DO's
    // response closed its context (litmus `locks` could never finish a run).
    // The bound keeps a refused multi-megabyte PUT from being pulled through
    // the Worker just to say 423 — past it, the body is cancelled instead.
    if (request.body !== null && !request.bodyUsed) {
      try {
        const reader = request.body.getReader();
        let remaining = 1 << 20;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          remaining -= value?.byteLength ?? 0;
          if (remaining <= 0) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      } catch {
        // Draining is best-effort; the response is already decided.
      }
    }
    return response;
  };
}

interface RequestContext {
  readonly request: Request;
  readonly url: URL;
  readonly backend: WebdavBackend;
  readonly principal: Principal;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Auth bridge (spec §1)
// ---------------------------------------------------------------------------

async function authenticate(
  request: Request,
  backend: WebdavBackend,
  origin: string,
): Promise<Principal | Response> {
  const basic = parseBasicAuthorization(request.headers.get("authorization"));
  if (basic === null) return unauthorized(origin);
  const result = await backend.credentials.verify(
    basic.username,
    basic.password,
  );
  if (!result.ok) {
    if (result.reason === "throttled") {
      return dav("Too many attempts", 429, {
        "Retry-After": "900",
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    return unauthorized(origin);
  }
  return { webid: result.record.webid, record: result.record };
}

/**
 * Effective access is `app-password scope ∩ WAC` (spec §1): the credential's
 * scope is an upper bound, then the request is authorized exactly as a Solid
 * request would be.
 */
async function authorize(
  ctx: RequestContext,
  mode: WebdavMode,
  path = ctx.path,
): Promise<boolean> {
  const { scope } = ctx.principal.record;
  if (!scope.modes.includes(mode)) return false;
  if (
    scope.pathPrefix !== undefined &&
    !isWithinPathPrefix(path, scope.pathPrefix)
  ) {
    return false;
  }
  return ctx.backend.authorize(ctx.principal.webid, path, mode);
}

/**
 * Whether `path` is the prefix collection itself or a descendant of it, matched
 * on a **path-segment boundary** — not a raw `startsWith`, which would let a
 * credential scoped to `/photos` also reach the sibling `/photos-private`.
 */
function isWithinPathPrefix(path: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (base === "") return true; // `/` or empty scopes the whole pod
  return path === base || path.startsWith(`${base}/`);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Map a request URL to a pod path, or `null` when outside the mount. */
function pathOf(url: URL, resolved: Resolved): string | null {
  const pathname = normalizePercentEncoding(url.pathname);
  if (resolved.mountPrefix === "") return pathname || "/";
  if (pathname === resolved.mountPrefix) return resolved.storageRoot;
  if (pathname.startsWith(`${resolved.mountPrefix}/`)) {
    return pathname.slice(resolved.mountPrefix.length);
  }
  return null;
}

/** Map a pod path back to the client-visible href under the mount. */
function hrefOf(path: string, resolved: Resolved): string {
  return `${resolved.mountPrefix}${path}`;
}

function isCollectionPath(path: string): boolean {
  return path.endsWith("/");
}

function isAuxiliary(path: string): boolean {
  return path.endsWith(".acl") || path.endsWith(".meta");
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return decodeURIComponent(trimmed.slice(trimmed.lastIndexOf("/") + 1));
}

/** Every lock token the request's `If:` header submits (RFC 4918 §7.1). */
function presentedTokens(request: Request): readonly string[] {
  return submittedLockTokens(parseIfHeader(request.headers.get("if")));
}

/**
 * Evaluate a parsed `If:` header as a precondition (RFC 4918 §10.4.3): true
 * iff at least one list has every condition true. A `<token>` condition is
 * true when the list's target is currently locked with exactly that token
 * (`DAV:no-lock` therefore never matches — the `(Not <DAV:no-lock>)`
 * always-true idiom falls out); an `[etag]` condition compares against the
 * target's current ETag. Untagged lists target the request-URI; tagged lists
 * target their own resource, and a tag outside this mount simply evaluates
 * its conditions against a resource with no locks and no ETag.
 */
async function evaluateIf(
  lists: readonly IfList[],
  backend: WebdavBackend,
  resolved: Resolved,
  requestUrl: URL,
  requestPath: string,
): Promise<boolean> {
  const etags = new Map<string, string | null>();
  const etagOf = async (path: string | null): Promise<string | null> => {
    if (path === null) return null;
    const cached = etags.get(path);
    if (cached !== undefined) return cached;
    const etag = (await backend.stat(path))?.etag ?? null;
    etags.set(path, etag);
    return etag;
  };
  for (const list of lists) {
    let target: string | null = requestPath;
    if (list.resourceTag !== undefined) {
      try {
        target = pathOf(new URL(list.resourceTag, requestUrl), resolved);
      } catch {
        target = null;
      }
    }
    let all = true;
    for (const condition of list.conditions) {
      let value: boolean;
      if (condition.lockToken !== undefined) {
        value =
          target !== null &&
          backend.locks
            .locksOn(target)
            .some((lock) => lock.token === condition.lockToken);
      } else {
        value =
          condition.etag !== undefined &&
          (await etagOf(target)) === condition.etag;
      }
      if (condition.not) value = !value;
      if (!value) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** Translate a thrown backend error into the right WebDAV status. */
function mapWriteError(error: unknown): Response {
  if (error instanceof PreconditionFailed)
    return problem(412, "Precondition failed");
  if (error instanceof CollectionNotEmpty)
    return problem(409, "Collection not empty");
  if (error instanceof ResourceConflict) return problem(409, "Conflict");
  throw error;
}

// ---------------------------------------------------------------------------
// GET / HEAD
// ---------------------------------------------------------------------------

async function read(ctx: RequestContext, headOnly: boolean): Promise<Response> {
  if (!(await authorize(ctx, "read"))) return problem(403, "Forbidden");
  const stat = await ctx.backend.stat(ctx.path);
  if (stat === null) return problem(404, "Not found");
  if (stat.collection) {
    // A bare GET on a collection has no standard body; report metadata.
    return dav(null, 204, {
      ETag: stat.etag,
      "Last-Modified": new Date(stat.lastModified).toUTCString(),
    });
  }
  const headers: Record<string, string> = {
    ETag: stat.etag,
    "Content-Type": stat.contentType,
    "Content-Length": String(stat.contentLength),
    "Last-Modified": new Date(stat.lastModified).toUTCString(),
    "Accept-Ranges": "bytes",
  };
  if (headOnly) return dav(null, 200, headers);
  const body = await ctx.backend.read(ctx.path);
  if (body === null) return problem(404, "Not found");
  return dav(body.body, 200, headers);
}

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

async function put(ctx: RequestContext, resolved: Resolved): Promise<Response> {
  if (isCollectionPath(ctx.path)) {
    return methodNotAllowed(
      "Cannot PUT a collection; use MKCOL",
      resolved,
      ctx.path,
    );
  }
  if (resolved.litter && isOsLitter(ctx.path, resolved.litter)) {
    return problem(403, "Resource name refused by the OS-litter policy");
  }
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");

  const blocking = ctx.backend.locks.blockingLock(
    ctx.path,
    presentedTokens(ctx.request),
  );
  if (blocking) return lockedResponse(blocking, resolved);

  const contentType = inferContentType(
    ctx.path,
    ctx.request.headers.get("content-type"),
  );
  try {
    const outcome = await ctx.backend.write(
      ctx.path,
      ctx.request.body,
      contentType,
      preconditionsOf(ctx.request),
      contentLengthOf(ctx.request),
    );
    return dav(null, outcome.created ? 201 : 204, etagHeader(outcome.etag));
  } catch (error) {
    return mapWriteError(error);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

async function remove(
  ctx: RequestContext,
  resolved: Resolved,
): Promise<Response> {
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");
  // RFC 4918 requires DELETE on a nonexistent resource to fail (litmus
  // `delete_null`); the backend contract otherwise makes no promise about
  // treating a missing target as a no-op vs. an error.
  if ((await ctx.backend.stat(ctx.path)) === null) {
    return problem(404, "Not found");
  }
  const blocking = ctx.backend.locks.blockingLock(
    ctx.path,
    presentedTokens(ctx.request),
  );
  if (blocking) return lockedResponse(blocking, resolved);
  try {
    await ctx.backend.remove(ctx.path, preconditionsOf(ctx.request));
    return dav(null, 204);
  } catch (error) {
    return mapWriteError(error);
  }
}

// ---------------------------------------------------------------------------
// MKCOL
// ---------------------------------------------------------------------------

/**
 * Whether `request` actually carries body bytes, checked by reading (and
 * discarding) its first chunk rather than trusting headers alone. A
 * `Content-Length: 0` request has a `null` body and is trivially empty, but a
 * chunked-encoded request (no `Content-Length` — its length is unknown up
 * front) can legitimately carry a non-null body stream that yields zero bytes;
 * treating "non-null body" alone as "has a body" would 415 that legitimate
 * empty MKCOL alongside a real one.
 */
async function hasBodyBytes(request: Request): Promise<boolean> {
  if (request.body === null) return false;
  const reader = request.body.getReader();
  try {
    const { done, value } = await reader.read();
    return !done && (value?.byteLength ?? 0) > 0;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function mkcol(
  ctx: RequestContext,
  resolved: Resolved,
): Promise<Response> {
  // RFC 4918 §9.3: MKCOL with a request body is unsupported media (415).
  if (await hasBodyBytes(ctx.request)) {
    return problem(415, "MKCOL bodies are not supported");
  }
  const collectionPath = isCollectionPath(ctx.path) ? ctx.path : `${ctx.path}/`;
  const mkctx = { ...ctx, path: collectionPath };
  if (!(await authorize(mkctx, "write"))) return problem(403, "Forbidden");
  // A plain (non-collection) resource is stored under the un-slashed name, so
  // checking only `collectionPath` (litmus `mkcol_over_plain`) misses it —
  // MKCOL would silently create a same-named collection alongside it instead
  // of refusing. `ctx.path` alone is not enough either: neon's ne_mkcol()
  // always sends a trailing slash, making `ctx.path` the collection form, so
  // the un-slashed name must be derived and checked explicitly.
  const plainPath = collectionPath.slice(0, -1);
  if (
    (plainPath !== "" && (await ctx.backend.stat(plainPath)) !== null) ||
    (await ctx.backend.stat(collectionPath)) !== null
  ) {
    return methodNotAllowed(
      "Collection already exists",
      resolved,
      collectionPath,
    );
  }
  try {
    await ctx.backend.makeCollection(collectionPath);
    return dav(null, 201);
  } catch (error) {
    return mapWriteError(error);
  }
}

// ---------------------------------------------------------------------------
// COPY / MOVE
// ---------------------------------------------------------------------------

async function copyMove(
  ctx: RequestContext,
  resolved: Resolved,
  method: "COPY" | "MOVE",
): Promise<Response> {
  let destination = destinationOf(ctx.request, ctx.url, resolved);
  if (destination === "foreign")
    return problem(502, "Destination is on a different server");
  if (destination === null)
    return problem(400, "Missing or invalid Destination");
  // A collection's destination must be a collection path; without this a client
  // that drops the trailing slash (`/dir` for `/dir/`) would slip past the
  // equality, into-itself, and lock guards below and corrupt child paths in the
  // backend copy. Normalize once, up front.
  if (isCollectionPath(ctx.path) && !destination.endsWith("/")) {
    destination = `${destination}/`;
  }
  if (isAuxiliary(destination)) return problem(403, "Forbidden destination");
  if (destination === ctx.path)
    return problem(403, "Source and destination are equal");
  if ((await ctx.backend.stat(ctx.path)) === null) {
    return problem(404, "Not found");
  }
  // A collection cannot be copied/moved into its own subtree (RFC 4918 §9.8.5 /
  // §9.9.4) — and it would otherwise recurse without end.
  if (isCollectionPath(ctx.path) && destination.startsWith(ctx.path)) {
    return problem(409, "Cannot copy or move a collection into itself");
  }

  const depth =
    method === "COPY" ? depthOf(ctx.request, "infinity") : "infinity";
  if (depth === "bad") return problem(400, "Invalid Depth");
  const overwrite =
    (ctx.request.headers.get("overwrite") ?? "T").toUpperCase() !== "F";

  // MOVE mutates the source; both verbs mutate the destination.
  const token = presentedTokens(ctx.request);
  if (method === "MOVE") {
    const srcLock = ctx.backend.locks.blockingLock(ctx.path, token);
    if (srcLock) return lockedResponse(srcLock, resolved);
  }
  const dstLock = ctx.backend.locks.blockingLock(destination, token);
  if (dstLock) return lockedResponse(dstLock, resolved);

  const okSource =
    method === "MOVE"
      ? await authorize(ctx, "write")
      : await authorize(ctx, "read");
  const okDest = await authorize({ ...ctx, path: destination }, "write");
  if (!okSource || !okDest) return problem(403, "Forbidden");

  const existing = await ctx.backend.stat(destination);
  if (existing !== null && !overwrite)
    return problem(412, "Destination exists");

  try {
    const outcome =
      method === "COPY"
        ? await ctx.backend.copy(ctx.path, destination, depth, overwrite)
        : await ctx.backend.move(ctx.path, destination, depth, overwrite);
    return dav(null, outcome.created ? 201 : 204);
  } catch (error) {
    return mapWriteError(error);
  }
}

// ---------------------------------------------------------------------------
// PROPFIND
// ---------------------------------------------------------------------------

async function propfind(
  ctx: RequestContext,
  resolved: Resolved,
): Promise<Response> {
  if (!(await authorize(ctx, "read"))) return problem(403, "Forbidden");

  const depthHeader = (
    ctx.request.headers.get("depth") ?? "infinity"
  ).toLowerCase();
  if (depthHeader === "infinity") {
    // A `Depth: infinity` PROPFIND can enumerate the whole pod; refuse it (§4).
    // RFC 4918 §9.1 defines the `propfind-finite-depth` precondition marker so
    // the client knows to retry with a finite depth.
    return xml(
      403,
      `<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>`,
    );
  }
  if (depthHeader !== "0" && depthHeader !== "1") {
    return problem(400, "Invalid Depth");
  }

  let selection: PropSelection;
  try {
    selection = await parsePropfindBody(ctx.request);
  } catch (error) {
    if (error instanceof XmlError) return problem(error.status, error.message);
    throw error;
  }

  const root = await ctx.backend.stat(ctx.path);
  if (root === null) return problem(404, "Not found");

  const stats: ResourceStat[] = [root];
  if (depthHeader === "1" && root.collection) {
    for (const child of await ctx.backend.listChildren(ctx.path)) {
      if (isAuxiliary(child.path)) continue;
      if (resolved.litter && isOsLitter(child.path, resolved.litter)) continue;
      stats.push({ ...child });
    }
  }

  const responses = stats
    .map((stat) => responseXml(stat, selection, ctx.backend, resolved))
    .join("");
  return xml(207, `<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`);
}

type PropSelection =
  | { readonly kind: "allprop" }
  | { readonly kind: "propname" }
  | { readonly kind: "prop"; readonly names: readonly PropName[] };

interface PropName {
  readonly ns: string | null;
  readonly local: string;
}

async function parsePropfindBody(request: Request): Promise<PropSelection> {
  const text = await request.text();
  if (text.trim() === "") return { kind: "allprop" };
  guardCharset(request);
  const root = parseXml(text, XML_LIMITS);
  if (root.ns !== "DAV:" || root.local !== "propfind") {
    throw new XmlError("expected a DAV:propfind body");
  }
  if (root.children.some((c) => c.ns === "DAV:" && c.local === "allprop")) {
    return { kind: "allprop" };
  }
  if (root.children.some((c) => c.ns === "DAV:" && c.local === "propname")) {
    return { kind: "propname" };
  }
  const prop = root.children.find((c) => c.ns === "DAV:" && c.local === "prop");
  if (prop === undefined) throw new XmlError("DAV:propfind must request props");
  return {
    kind: "prop",
    names: prop.children.map((c) => ({ ns: c.ns, local: c.local })),
  };
}

/** The live properties the façade supports (spec §4). */
const LIVE_PROPS = [
  "displayname",
  "getcontentlength",
  "getcontenttype",
  "getlastmodified",
  "getetag",
  "resourcetype",
  "lockdiscovery",
  "supportedlock",
  "creationdate",
] as const;
type LivePropName = (typeof LIVE_PROPS)[number];

function livePropValue(
  name: LivePropName,
  stat: ResourceStat,
  backend: WebdavBackend,
  resolved: Resolved,
): string {
  switch (name) {
    case "displayname":
      return `<D:displayname>${escapeXml(basename(stat.path))}</D:displayname>`;
    case "getcontentlength":
      return stat.collection
        ? ""
        : `<D:getcontentlength>${stat.contentLength}</D:getcontentlength>`;
    case "getcontenttype":
      return stat.collection
        ? ""
        : `<D:getcontenttype>${escapeXml(stat.contentType)}</D:getcontenttype>`;
    case "getlastmodified":
      return `<D:getlastmodified>${new Date(stat.lastModified).toUTCString()}</D:getlastmodified>`;
    case "getetag":
      return `<D:getetag>${escapeXml(stat.etag)}</D:getetag>`;
    case "resourcetype":
      return stat.collection
        ? "<D:resourcetype><D:collection/></D:resourcetype>"
        : "<D:resourcetype/>";
    case "supportedlock":
      return SUPPORTED_LOCK;
    case "lockdiscovery":
      return lockDiscovery(backend.locks.locksOn(stat.path), resolved);
    case "creationdate":
      return stat.createdAt === undefined
        ? ""
        : `<D:creationdate>${new Date(stat.createdAt).toISOString()}</D:creationdate>`;
  }
}

const SUPPORTED_LOCK =
  "<D:supportedlock><D:lockentry>" +
  "<D:lockscope><D:exclusive/></D:lockscope>" +
  "<D:locktype><D:write/></D:locktype>" +
  "</D:lockentry><D:lockentry>" +
  "<D:lockscope><D:shared/></D:lockscope>" +
  "<D:locktype><D:write/></D:locktype>" +
  "</D:lockentry></D:supportedlock>";

/**
 * Serialize one stored dead property as a value-bearing element. Each element
 * is namespace-self-contained (a fresh `x` prefix declaration, or bare for the
 * null namespace — litmus `propnullns`), and the persisted value fragment's
 * child elements carry their own `xmlns="…"` declarations (litmus
 * `propvalnspace`), so nothing can collide with the multistatus's `D:` prefix.
 */
function deadPropXml(prop: DeadProperty): string {
  // `local` always comes from the parser today (name chars only), but escape
  // it like `qname()` does so a future non-parser `PropertyStore` writer
  // cannot break the emitted XML.
  const local = escapeXml(prop.local);
  if (prop.ns === null) {
    return `<${local}>${prop.valueXml}</${local}>`;
  }
  if (prop.ns === "DAV:") {
    return `<D:${local}>${prop.valueXml}</D:${local}>`;
  }
  return `<x:${local} xmlns:x="${escapeXml(prop.ns)}">${prop.valueXml}</x:${local}>`;
}

function isLiveName(req: PropName): boolean {
  return (
    req.ns === "DAV:" && (LIVE_PROPS as readonly string[]).includes(req.local)
  );
}

function responseXml(
  stat: ResourceStat,
  selection: PropSelection,
  backend: WebdavBackend,
  resolved: Resolved,
): string {
  const href = `<D:href>${escapeXml(hrefOf(stat.path, resolved))}</D:href>`;
  const dead = backend.properties.list(stat.path);

  if (selection.kind === "propname") {
    const names =
      LIVE_PROPS.filter((n) => livePropValue(n, stat, backend, resolved) !== "")
        .map((n) => `<D:${n}/>`)
        .join("") + dead.map((p) => `<${qname(p)}/>`).join("");
    return `<D:response>${href}<D:propstat><D:prop>${names}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat></D:response>`;
  }

  const found: string[] = [];
  const missing: PropName[] = [];

  if (selection.kind === "allprop") {
    for (const name of LIVE_PROPS) {
      const value = livePropValue(name, stat, backend, resolved);
      if (value !== "") found.push(value);
    }
    for (const prop of dead) found.push(deadPropXml(prop));
  } else {
    for (const req of selection.names) {
      if (isLiveName(req)) {
        // A live prop that does not apply here (e.g. `getcontentlength` on a
        // collection, `creationdate` untracked) is omitted, matching the
        // pre-dead-prop behaviour — omitted, not reported 404.
        const value = livePropValue(
          req.local as LivePropName,
          stat,
          backend,
          resolved,
        );
        if (value !== "") found.push(value);
        continue;
      }
      const match = dead.find((p) => p.ns === req.ns && p.local === req.local);
      if (match) found.push(deadPropXml(match));
      else missing.push(req);
    }
  }

  let body = `<D:propstat><D:prop>${found.join("")}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat>`;

  if (missing.length > 0) {
    const empties = missing.map((req) => `<${qname(req)}/>`).join("");
    body += `<D:propstat><D:prop>${empties}</D:prop><D:status>${statusLine(404)}</D:status></D:propstat>`;
  }

  return `<D:response>${href}${body}</D:response>`;
}

function qname(name: PropName): string {
  if (name.ns === "DAV:") return `D:${name.local}`;
  if (name.ns === null) return escapeXml(name.local);
  return `x:${escapeXml(name.local)} xmlns:x="${escapeXml(name.ns)}"`;
}

// ---------------------------------------------------------------------------
// PROPPATCH (dead-property store — spec §4)
// ---------------------------------------------------------------------------

/** One parsed `propertyupdate` instruction, in document order. */
interface PropOp {
  readonly kind: "set" | "remove";
  readonly ns: string | null;
  readonly local: string;
  /** The property element itself (its inner content is the value), for `set`. */
  readonly element: XmlElement | null;
}

/** Dedupe key for a property name; ` ` cannot occur in an XML name. */
function propKey(ns: string | null, local: string): string {
  return `${ns ?? ""} ${local}`;
}

async function proppatch(
  ctx: RequestContext,
  resolved: Resolved,
): Promise<Response> {
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");
  const blocking = ctx.backend.locks.blockingLock(
    ctx.path,
    presentedTokens(ctx.request),
  );
  if (blocking) return lockedResponse(blocking, resolved);
  const stat = await ctx.backend.stat(ctx.path);
  if (stat === null) return problem(404, "Not found");

  let root: XmlElement;
  try {
    const text = await ctx.request.text();
    guardCharset(ctx.request);
    root = parseXml(text, XML_LIMITS);
  } catch (error) {
    if (error instanceof XmlError) return problem(error.status, error.message);
    throw error;
  }
  if (root.ns !== "DAV:" || root.local !== "propertyupdate") {
    return problem(400, "Expected a DAV:propertyupdate body");
  }

  const ops: PropOp[] = [];
  for (const action of root.children) {
    if (
      action.ns !== "DAV:" ||
      (action.local !== "set" && action.local !== "remove")
    ) {
      continue;
    }
    const prop = action.children.find(
      (c) => c.ns === "DAV:" && c.local === "prop",
    );
    for (const p of prop?.children ?? []) {
      ops.push({
        kind: action.local,
        ns: p.ns,
        local: p.local,
        element: action.local === "set" ? p : null,
      });
    }
  }

  const isProtected = (op: PropOp): boolean =>
    op.ns === "DAV:" && (LIVE_PROPS as readonly string[]).includes(op.local);
  const href = `<D:href>${escapeXml(hrefOf(ctx.path, resolved))}</D:href>`;
  const propstat = (names: readonly PropName[], code: number): string =>
    `<D:propstat><D:prop>${names.map((n) => `<${qname(n)}/>`).join("")}</D:prop><D:status>${statusLine(code)}</D:status></D:propstat>`;
  const respond = (entries: string): Response =>
    xml(
      207,
      `<D:multistatus xmlns:D="DAV:"><D:response>${href}${entries}</D:response></D:multistatus>`,
    );

  // A PROPPATCH is atomic (RFC 4918 §9.2): a protected live property fails 403
  // and drags every other instruction down as 424 Failed Dependency — nothing
  // is persisted.
  if (ops.some(isProtected)) {
    const byKey = new Map<string, { name: PropName; code: number }>();
    for (const op of ops) {
      const code = isProtected(op) ? 403 : 424;
      const key = propKey(op.ns, op.local);
      const prior = byKey.get(key);
      if (!prior || code === 403) {
        byKey.set(key, { name: { ns: op.ns, local: op.local }, code });
      }
    }
    const all = [...byKey.values()];
    const rejected = all.filter((e) => e.code === 403).map((e) => e.name);
    const dependent = all.filter((e) => e.code === 424).map((e) => e.name);
    return respond(
      propstat(rejected, 403) +
        (dependent.length > 0 ? propstat(dependent, 424) : ""),
    );
  }

  // Apply in document order (litmus `propremoveset`/`propsetremove`): the last
  // instruction for a property wins. DO SQLite is synchronous and the DO is
  // single-threaded, so the loop is effectively one atomic batch.
  const applied = new Map<string, PropName>();
  for (const op of ops) {
    if (op.kind === "set" && op.element !== null) {
      ctx.backend.properties.set(ctx.path, {
        ns: op.ns,
        local: op.local,
        valueXml: serializeFragment(op.element),
      });
    } else {
      // Removing an absent property still succeeds (RFC 4918 §9.2).
      ctx.backend.properties.remove(ctx.path, op.ns, op.local);
    }
    applied.set(propKey(op.ns, op.local), { ns: op.ns, local: op.local });
  }

  return respond(propstat([...applied.values()], 200));
}

// ---------------------------------------------------------------------------
// LOCK / UNLOCK (Class 2 — spec §2)
// ---------------------------------------------------------------------------

async function lock(
  ctx: RequestContext,
  resolved: Resolved,
): Promise<Response> {
  const timeout = effectiveTimeout(
    parseTimeoutHeader(ctx.request.headers.get("timeout")),
    resolved.lockPolicy,
  );

  const bodyText = (await ctx.request.text()).trim();

  // An empty body refreshes the lock named by the `If:` header (RFC 4918 §9.10).
  if (bodyText === "") {
    const token = presentedTokens(ctx.request)[0];
    if (token === undefined)
      return problem(400, "LOCK refresh needs a lock token");
    if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");
    const refreshed = ctx.backend.locks.refresh(token, timeout);
    if (refreshed === null) return problem(412, "No such lock to refresh");
    return xml(200, lockProp([refreshed], resolved), {
      "Lock-Token": `<${refreshed.token}>`,
    });
  }

  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");

  let info: { depth: "0" | "infinity"; scope: LockScope; ownerHref: string };
  try {
    guardCharset(ctx.request);
    info = parseLockInfo(parseXml(bodyText, XML_LIMITS), ctx.request);
  } catch (error) {
    if (error instanceof XmlError) return problem(error.status, error.message);
    throw error;
  }

  const result = ctx.backend.locks.acquire({
    path: ctx.path,
    depth: info.depth,
    scope: info.scope,
    ownerHref: info.ownerHref,
    webid: ctx.principal.webid,
    timeoutSeconds: timeout,
  });
  if (!result.ok) {
    if (result.reason === "forbidden") {
      return problem(403, "Lock scope is forbidden (root or depth bound)");
    }
    return problem(423, "Locked");
  }

  // A LOCK on an unmapped URL creates an empty locked resource (RFC 4918 §7.3).
  // RFC 4918 defines no lock-null *collection*, so a LOCK of a non-existent
  // collection is rejected `409` and the just-acquired lock is rolled back —
  // rather than falsely reporting `201 Created` with nothing created.
  const created = (await ctx.backend.stat(ctx.path)) === null;
  if (created) {
    if (isCollectionPath(ctx.path)) {
      ctx.backend.locks.unlock(result.lock.token);
      return problem(409, "Cannot lock a non-existent collection");
    }
    try {
      await ctx.backend.write(ctx.path, null, "application/octet-stream", {});
    } catch {
      ctx.backend.locks.unlock(result.lock.token);
      return problem(409, "Cannot create lock-null resource");
    }
  }

  return xml(created ? 201 : 200, lockProp([result.lock], resolved), {
    "Lock-Token": `<${result.lock.token}>`,
  });
}

async function unlock(ctx: RequestContext): Promise<Response> {
  const header = ctx.request.headers.get("lock-token");
  const token = header ? header.trim().replace(/^<|>$/g, "") : "";
  if (token === "") return problem(400, "Missing Lock-Token");
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");
  const removed = ctx.backend.locks.unlock(token);
  if (!removed) return problem(409, "No such lock");
  return dav(null, 204);
}

function parseLockInfo(
  root: XmlElement,
  request: Request,
): { depth: "0" | "infinity"; scope: LockScope; ownerHref: string } {
  if (root.ns !== "DAV:" || root.local !== "lockinfo") {
    throw new XmlError("expected a DAV:lockinfo body");
  }
  const scopeElement = root.children.find(
    (c) => c.ns === "DAV:" && c.local === "lockscope",
  );
  const scope: LockScope | null = scopeElement?.children.some(
    (c) => c.ns === "DAV:" && c.local === "exclusive",
  )
    ? "exclusive"
    : scopeElement?.children.some(
          (c) => c.ns === "DAV:" && c.local === "shared",
        )
      ? "shared"
      : null;
  if (scope === null) {
    throw new XmlError("expected an exclusive or shared lockscope");
  }
  const owner = root.children.find(
    (c) => c.ns === "DAV:" && c.local === "owner",
  );
  const ownerHref = owner
    ? (owner.children.find((c) => c.ns === "DAV:" && c.local === "href")
        ?.text ?? owner.text)
    : "";
  const depth = (request.headers.get("depth") ?? "infinity").toLowerCase();
  return {
    depth: depth === "0" ? "0" : "infinity",
    scope,
    ownerHref: ownerHref.trim(),
  };
}

function lockDiscovery(
  locks: readonly LockRecord[],
  resolved: Resolved,
): string {
  const active = locks
    .map((l) => {
      const owner = l.ownerHref
        ? `<D:owner>${escapeXml(l.ownerHref)}</D:owner>`
        : "";
      const timeout = Math.max(
        0,
        Math.round((l.expiresAt - resolved.now()) / 1000),
      );
      return (
        "<D:activelock>" +
        "<D:locktype><D:write/></D:locktype>" +
        `<D:lockscope><D:${l.scope === "shared" ? "shared" : "exclusive"}/></D:lockscope>` +
        `<D:depth>${l.depth}</D:depth>` +
        owner +
        `<D:timeout>Second-${timeout}</D:timeout>` +
        `<D:locktoken><D:href>${escapeXml(l.token)}</D:href></D:locktoken>` +
        `<D:lockroot><D:href>${escapeXml(hrefOf(l.path, resolved))}</D:href></D:lockroot>` +
        "</D:activelock>"
      );
    })
    .join("");
  // Returned bare for PROPFIND; wrapped via `lockProp` for the LOCK response.
  return `<D:lockdiscovery>${active}</D:lockdiscovery>`;
}

/** The standalone `<D:prop>` document a LOCK response returns (RFC 4918 §9.10). */
function lockProp(locks: readonly LockRecord[], resolved: Resolved): string {
  return `<D:prop xmlns:D="DAV:">${lockDiscovery(locks, resolved)}</D:prop>`;
}

/** A `423 Locked` carrying the offending lock token (RFC 4918 §10.6). */
function lockedResponse(lock: LockRecord, resolved: Resolved): Response {
  return xml(
    423,
    `<D:error xmlns:D="DAV:"><D:lock-token-submitted><D:href>${escapeXml(hrefOf(lock.path, resolved))}</D:href></D:lock-token-submitted></D:error>`,
  );
}

// ---------------------------------------------------------------------------
// Shared header helpers
// ---------------------------------------------------------------------------

function etagHeader(etag: string | undefined): Record<string, string> {
  return etag === undefined ? {} : { ETag: etag };
}

/** The request's declared `Content-Length` as a non-negative integer, or `null`. */
function contentLengthOf(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function preconditionsOf(request: Request): {
  ifMatch?: string;
  ifNoneMatch?: string;
} {
  const ifMatch = request.headers.get("if-match");
  const ifNoneMatch = request.headers.get("if-none-match");
  // The `If:` header's `[etag]` production is a state condition the request
  // must satisfy (RFC 4918 §10.4.2). The router already evaluated the full
  // header (412 on false), but for the unambiguous shape — a single untagged
  // list with exactly one positive ETag — it is additionally mapped onto
  // `If-Match` so the TOCTOU-free write path re-checks it inside the DO
  // transaction. Multi-list (OR) shapes cannot collapse to one `If-Match`,
  // so they rely on the router evaluation alone. An explicit `If-Match`
  // header takes precedence.
  const parsed = parseIfHeader(request.headers.get("if"));
  let ifEtag: string | undefined;
  if (parsed.kind === "lists" && parsed.lists.length === 1) {
    const only = parsed.lists[0];
    if (only !== undefined && only.resourceTag === undefined) {
      const positiveEtags = only.conditions.filter(
        (c) => c.etag !== undefined && !c.not,
      );
      if (positiveEtags.length === 1 && only.conditions.every((c) => !c.not)) {
        ifEtag = positiveEtags[0]?.etag;
      }
    }
  }
  return {
    ...(ifMatch !== null
      ? { ifMatch: ifMatch.trim() }
      : ifEtag !== undefined
        ? { ifMatch: ifEtag }
        : {}),
    ...(ifNoneMatch !== null ? { ifNoneMatch: ifNoneMatch.trim() } : {}),
  };
}

/** Reject a non-UTF-8 request charset before the bounded parser (spec §4). */
function guardCharset(request: Request): void {
  const ct = request.headers.get("content-type") ?? "";
  const charset = /charset\s*=\s*"?([^";]+)"?/i.exec(ct);
  if (charset && charset[1] && charset[1].trim().toLowerCase() !== "utf-8") {
    throw new XmlError(`unsupported charset "${charset[1]}"`, 415);
  }
}

function depthOf(
  request: Request,
  fallback: "0" | "infinity",
): "0" | "infinity" | "bad" {
  const raw = request.headers.get("depth");
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if (value === "0") return "0";
  if (value === "infinity") return "infinity";
  return "bad";
}

/**
 * Resolve a COPY/MOVE `Destination` to a pod path under the mount. `null` is a
 * missing/invalid/out-of-mount header (`400`); `"foreign"` is a syntactically
 * valid URL on another origin, which RFC 4918 §9.8.5/§9.9 answers `502`.
 */
function destinationOf(
  request: Request,
  url: URL,
  resolved: Resolved,
): string | null | "foreign" {
  const raw = request.headers.get("destination");
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw, url);
  } catch {
    return null;
  }
  if (target.origin !== url.origin) return "foreign";
  return pathOf(target, resolved);
}
