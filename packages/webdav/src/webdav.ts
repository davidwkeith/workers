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
import { parseIfHeader } from "./if-header.js";
import { isOsLitter, DEFAULT_OS_LITTER } from "./litter.js";
import {
  effectiveTimeout,
  parseTimeoutHeader,
  type LockRecord,
} from "./locks.js";
import { escapeXml, parseXml, type XmlElement, XmlError } from "./xml.js";

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

function resolve(config: WebdavConfig): Resolved {
  const url = new URL(config.baseUrl);
  const rawMount = config.mountPath ?? "/";
  const mount = rawMount.endsWith("/") ? rawMount.slice(0, -1) : rawMount;
  const storageRoot = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
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

function problem(status: number, message: string): Response {
  return dav(message, status, { "Content-Type": "text/plain; charset=utf-8" });
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

  return async function webdav(request, env): Promise<Response> {
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
      const allow = path === resolved.storageRoot ? ROOT_METHODS : ALL_METHODS;
      return dav(null, 204, { Allow: allow });
    }

    const principal = await authenticate(request, backend, resolved.origin);
    if (principal instanceof Response) return principal;

    const path = pathOf(url, resolved);
    if (path === null) return problem(404, "Not found");

    // Auxiliary resources are Solid control-plane, never files: every verb
    // against `.acl`/`.meta` is 404 (spec §3) — not merely hidden.
    if (isAuxiliary(path)) return problem(404, "Not found");

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
        return remove(ctx);
      case "MKCOL":
        return mkcol(ctx);
      case "COPY":
      case "MOVE":
        return copyMove(ctx, resolved, method);
      case "LOCK":
        return lock(ctx, resolved);
      case "UNLOCK":
        return unlock(ctx);
      default:
        return problem(405, "Method not allowed");
    }
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
  if (scope.pathPrefix !== undefined && !path.startsWith(scope.pathPrefix)) {
    return false;
  }
  return ctx.backend.authorize(ctx.principal.webid, path, mode);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Map a request URL to a pod path, or `null` when outside the mount. */
function pathOf(url: URL, resolved: Resolved): string | null {
  const { pathname } = url;
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

/** The lock token a request presented in its `If:` header, if any. */
function presentedToken(request: Request): string | undefined {
  const parsed = parseIfHeader(request.headers.get("if"));
  return parsed.kind === "supported" ? parsed.condition.lockToken : undefined;
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
    return problem(405, "Cannot PUT a collection; use MKCOL");
  }
  if (resolved.litter && isOsLitter(ctx.path, resolved.litter)) {
    return problem(403, "Resource name refused by the OS-litter policy");
  }
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");

  const blocking = ctx.backend.locks.blockingLock(
    ctx.path,
    presentedToken(ctx.request),
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

async function remove(ctx: RequestContext): Promise<Response> {
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");
  const blocking = ctx.backend.locks.blockingLock(
    ctx.path,
    presentedToken(ctx.request),
  );
  if (blocking) return problem(423, "Locked");
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

async function mkcol(ctx: RequestContext): Promise<Response> {
  // RFC 4918 §9.3: MKCOL with a request body is unsupported media (415).
  if (
    ctx.request.body !== null &&
    (ctx.request.headers.get("content-length") ?? "0") !== "0"
  ) {
    return problem(415, "MKCOL bodies are not supported");
  }
  const collectionPath = isCollectionPath(ctx.path) ? ctx.path : `${ctx.path}/`;
  const mkctx = { ...ctx, path: collectionPath };
  if (!(await authorize(mkctx, "write"))) return problem(403, "Forbidden");
  if ((await ctx.backend.stat(collectionPath)) !== null) {
    return problem(405, "Collection already exists");
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
  const destination = destinationOf(ctx.request, ctx.url, resolved);
  if (destination === null)
    return problem(400, "Missing or invalid Destination");
  if (isAuxiliary(destination)) return problem(403, "Forbidden destination");
  if (destination === ctx.path)
    return problem(403, "Source and destination are equal");

  const depth =
    method === "COPY" ? depthOf(ctx.request, "infinity") : "infinity";
  if (depth === "bad") return problem(400, "Invalid Depth");
  const overwrite =
    (ctx.request.headers.get("overwrite") ?? "T").toUpperCase() !== "F";

  // MOVE mutates the source; both verbs mutate the destination.
  const token = presentedToken(ctx.request);
  if (method === "MOVE") {
    const srcLock = ctx.backend.locks.blockingLock(ctx.path, token);
    if (srcLock) return problem(423, "Locked");
  }
  const dstLock = ctx.backend.locks.blockingLock(destination, token);
  if (dstLock) return problem(423, "Locked");

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
    return problem(403, "Depth: infinity PROPFIND is not supported");
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
  "</D:lockentry></D:supportedlock>";

function responseXml(
  stat: ResourceStat,
  selection: PropSelection,
  backend: WebdavBackend,
  resolved: Resolved,
): string {
  const href = `<D:href>${escapeXml(hrefOf(stat.path, resolved))}</D:href>`;

  if (selection.kind === "propname") {
    const names = LIVE_PROPS.filter(
      (n) => livePropValue(n, stat, backend, resolved) !== "",
    )
      .map((n) => `<D:${n}/>`)
      .join("");
    return `<D:response>${href}<D:propstat><D:prop>${names}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat></D:response>`;
  }

  const wanted: readonly LivePropName[] =
    selection.kind === "allprop"
      ? LIVE_PROPS
      : LIVE_PROPS.filter((n) =>
          selection.names.some((req) => req.ns === "DAV:" && req.local === n),
        );

  const found: string[] = [];
  for (const name of wanted) {
    const value = livePropValue(name, stat, backend, resolved);
    if (value !== "") found.push(value);
  }

  let body = `<D:propstat><D:prop>${found.join("")}</D:prop><D:status>${statusLine(200)}</D:status></D:propstat>`;

  if (selection.kind === "prop") {
    const missing = selection.names.filter(
      (req) =>
        !(
          req.ns === "DAV:" &&
          (LIVE_PROPS as readonly string[]).includes(req.local)
        ),
    );
    if (missing.length > 0) {
      const empties = missing.map((req) => `<${qname(req)}/>`).join("");
      body += `<D:propstat><D:prop>${empties}</D:prop><D:status>${statusLine(404)}</D:status></D:propstat>`;
    }
  }

  return `<D:response>${href}${body}</D:response>`;
}

function qname(name: PropName): string {
  if (name.ns === "DAV:") return `D:${name.local}`;
  if (name.ns === null) return escapeXml(name.local);
  return `x:${escapeXml(name.local)} xmlns:x="${escapeXml(name.ns)}"`;
}

// ---------------------------------------------------------------------------
// PROPPATCH (live/known-only — spec §4)
// ---------------------------------------------------------------------------

async function proppatch(
  ctx: RequestContext,
  resolved: Resolved,
): Promise<Response> {
  if (!(await authorize(ctx, "write"))) return problem(403, "Forbidden");
  const blocking = ctx.backend.locks.blockingLock(
    ctx.path,
    presentedToken(ctx.request),
  );
  if (blocking) return problem(423, "Locked");
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

  // No general dead-property store (spec §4): every set/remove of an arbitrary
  // dead property is accepted-and-ignored (200) so Finder/Explorer do not
  // error, but nothing is persisted. Protected live properties are 403.
  const props: PropName[] = [];
  for (const op of root.children) {
    if (op.ns !== "DAV:" || (op.local !== "set" && op.local !== "remove"))
      continue;
    const prop = op.children.find((c) => c.ns === "DAV:" && c.local === "prop");
    for (const p of prop?.children ?? [])
      props.push({ ns: p.ns, local: p.local });
  }

  const entries = props
    .map((p) => {
      const protectedLive =
        p.ns === "DAV:" && (LIVE_PROPS as readonly string[]).includes(p.local);
      const code = protectedLive ? 403 : 200;
      return `<D:propstat><D:prop><${qname(p)}/></D:prop><D:status>${statusLine(code)}</D:status></D:propstat>`;
    })
    .join("");
  const href = `<D:href>${escapeXml(hrefOf(ctx.path, resolved))}</D:href>`;
  return xml(
    207,
    `<D:multistatus xmlns:D="DAV:"><D:response>${href}${entries}</D:response></D:multistatus>`,
  );
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
    const token = presentedToken(ctx.request);
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

  let info: { depth: "0" | "infinity"; ownerHref: string };
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
): { depth: "0" | "infinity"; ownerHref: string } {
  if (root.ns !== "DAV:" || root.local !== "lockinfo") {
    throw new XmlError("expected a DAV:lockinfo body");
  }
  const scope = root.children.find(
    (c) => c.ns === "DAV:" && c.local === "lockscope",
  );
  if (
    !scope?.children.some((c) => c.ns === "DAV:" && c.local === "exclusive")
  ) {
    // Shared locks are deferred (spec §2); only exclusive write locks exist.
    throw new XmlError("only exclusive write locks are supported");
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
        "<D:lockscope><D:exclusive/></D:lockscope>" +
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
  return {
    ...(ifMatch !== null ? { ifMatch: ifMatch.trim() } : {}),
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

/** Resolve a COPY/MOVE `Destination` to a pod path under the mount, or `null`. */
function destinationOf(
  request: Request,
  url: URL,
  resolved: Resolved,
): string | null {
  const raw = request.headers.get("destination");
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw, url);
  } catch {
    return null;
  }
  if (target.origin !== url.origin) return null;
  return pathOf(target, resolved);
}
