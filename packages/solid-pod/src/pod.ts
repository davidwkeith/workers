/**
 * The per-pod Durable Object: the single-threaded consistency, authz, and
 * notification authority for one Solid Pod.
 *
 * The stateless front door (`handler.ts`) authenticates at the edge and hands
 * the verified agent facts to this object via internal headers; everything that
 * must be strongly consistent — LDP verbs, WAC, N3 Patch, `If-Match` writes,
 * DPoP `jti` replay, R2 copy-on-write through `@dwk/store`, and WebSocket
 * notifications — happens here, where Cloudflare guarantees a single thread per
 * pod. Consumers bind this class as a Durable Object namespace.
 */

import { DurableObject } from "cloudflare:workers";

import { DEFAULT_MAX_AGE_SECONDS } from "@dwk/dpop";
import {
  parse as parseRdf,
  serialize as serializeRdf,
  quadToStored,
  storedToQuad,
  formatForMediaType,
  type Quad,
  type StoredQuad,
  type StoredTerm,
} from "@dwk/rdf";
import {
  createStore,
  d1OrphanSink,
  forwardOrphans,
  PreconditionFailedError,
  type Store,
  type WriteOptions,
} from "@dwk/store";
import { discoverInboxIris, inboxLinkHeader } from "@dwk/ldn/discovery";
import type { AccessMode } from "@dwk/wac";

import { INTERNAL_HEADERS, type SolidPodEnv } from "./config";
import { PodOutcome } from "./log";
import {
  ancestorContainers,
  childKey,
  hasReservedAuxiliarySuffix,
  isAclPath,
  isContainer,
  parentContainer,
  resourceForAcl,
  toIri,
} from "./ldp";
import { negotiateMediaType, type Negotiated } from "./negotiation";
import {
  parsePatch,
  PatchConstraintError,
  PatchProblem,
  resolvePatch,
} from "./patch";
import { authorize, grantedModes } from "./wac";

const LDP = "http://www.w3.org/ns/ldp#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const ACTIVITYSTREAMS = "https://www.w3.org/ns/activitystreams";

/**
 * How long a write's DPoP `jti` is remembered for replay rejection. `@dwk/dpop`
 * accepts a proof whose `iat` lands anywhere in `±DEFAULT_MAX_AGE_SECONDS` of
 * now (`auth.ts` does not override `maxAgeSeconds`), so a single proof stays
 * cryptographically acceptable across a span of `2 × DEFAULT_MAX_AGE_SECONDS`.
 * The replay row MUST outlive that full window — otherwise it could be pruned
 * while the proof is still valid, reopening a replay hole — so the TTL is
 * anchored to it rather than a bare 5 minutes.
 */
const JTI_TTL_SECONDS = 2 * DEFAULT_MAX_AGE_SECONDS;

const SERIALIZE_PREFIXES: Record<string, string> = {
  ldp: LDP,
  acl: "http://www.w3.org/ns/auth/acl#",
  foaf: "http://xmlns.com/foaf/0.1/",
  solid: "http://www.w3.org/ns/solid/terms#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
};

const DEFAULT_GRAPH: StoredTerm = { termType: "DefaultGraph", value: "" };

/** Config the front door forwards to the DO (everything else is per-request). */
interface ForwardedConfig {
  readonly maxInlineBytes?: number;
  /** Owner WebIDs, always granted full access (bootstraps ACL management). */
  readonly owners?: readonly string[];
  /** Permit unauthenticated (proof-less) writes where WAC grants the public. */
  readonly allowAnonymousWrites?: boolean;
  /**
   * The storage root container's path (the pathname of the pod `baseUrl`,
   * normalized to a trailing slash; `"/"` for an origin-root pod). This single
   * container MUST NOT be deletable, so `DELETE` against it is refused and the
   * advertised `Allow` omits it.
   */
  readonly storageRoot?: string;
}

/** A change to announce to notification subscribers. */
type ChangeType = "Create" | "Update" | "Delete";

function text(
  status: number,
  body: string,
  headers: HeadersInit = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

/** A named-node triple in the default graph. */
function iriQuad(
  subject: string,
  predicate: string,
  object: string,
): StoredQuad {
  return {
    subject: { termType: "NamedNode", value: subject },
    predicate: { termType: "NamedNode", value: predicate },
    object: { termType: "NamedNode", value: object },
    graph: DEFAULT_GRAPH,
  };
}

/** Whether a stored quad is `<subject> ldp:contains <object>`. */
function isContainsQuad(quad: StoredQuad, subject: string): boolean {
  return (
    quad.subject.value === subject && quad.predicate.value === `${LDP}contains`
  );
}

export class SolidPodObject extends DurableObject<SolidPodEnv> {
  #store: Store | null = null;
  readonly #sql: SqlStorage;
  /** Owner WebIDs (deployment-constant), set from the forwarded config. */
  #owners: readonly string[] = [];
  /** Whether proof-less (anonymous) writes are permitted; see {@link JTI_TTL_SECONDS}. */
  #allowAnonymousWrites = false;
  /** The storage root container's path; this container is undeletable. */
  #storageRoot = "/";

  constructor(state: DurableObjectState, env: SolidPodEnv) {
    super(state, env);
    this.#sql = state.storage.sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS dpop_jti (
         jti        TEXT PRIMARY KEY,
         expires_at INTEGER NOT NULL
       )`,
    );
  }

  /** Lazily build the store with the front-door's offload threshold. */
  #getStore(config: ForwardedConfig): Store {
    if (this.#store === null) {
      this.#store = createStore(this.ctx, this.env, {
        ...(config.maxInlineBytes !== undefined
          ? { maxInlineBytes: config.maxInlineBytes }
          : {}),
      });
    }
    return this.#store;
  }

  /** The `Allow` method list for `path`, dropping DELETE on the storage root. */
  #allow(path: string): string {
    return allowFor(path, this.#storageRoot);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.#handleWebSocketUpgrade();
    }

    const config: ForwardedConfig = (() => {
      const raw = request.headers.get(INTERNAL_HEADERS.config);
      if (!raw) return {};
      try {
        return JSON.parse(raw) as ForwardedConfig;
      } catch {
        return {};
      }
    })();

    this.#owners = config.owners ?? [];
    this.#allowAnonymousWrites = config.allowAnonymousWrites ?? false;
    this.#storageRoot = config.storageRoot ?? "/";
    const store = this.#getStore(config);
    const url = new URL(request.url);
    const origin = url.origin;
    // Keep the path percent-encoded: decoding `%2F` would conflate it with a
    // real path separator and corrupt store keys / resource IRIs.
    const path = url.pathname;
    const webidHeader = request.headers.get(INTERNAL_HEADERS.webid);
    const agent =
      webidHeader && webidHeader.length > 0 ? webidHeader : undefined;
    const jti = request.headers.get(INTERNAL_HEADERS.jti) ?? undefined;
    const requestOrigin = request.headers.get("origin") ?? undefined;

    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return this.#options(path);

    try {
      switch (method) {
        case "HEAD":
        case "GET":
          return await this.#authorizeThenAsync(
            store,
            origin,
            path,
            "read",
            agent,
            requestOrigin,
            () =>
              this.#read(
                store,
                origin,
                path,
                request,
                method === "HEAD",
                agent,
                requestOrigin,
              ),
          );
        case "PUT":
          return await this.#authorizeThenAsync(
            store,
            origin,
            path,
            "write",
            agent,
            requestOrigin,
            () => this.#put(store, origin, path, request, jti),
          );
        case "POST":
          return await this.#authorizeThenAsync(
            store,
            origin,
            path,
            "append",
            agent,
            requestOrigin,
            () => this.#post(store, origin, path, request, jti),
          );
        case "PATCH":
          return await this.#patch(
            store,
            origin,
            path,
            request,
            agent,
            jti,
            requestOrigin,
          );
        case "DELETE":
          // The storage root container is undeletable, ahead of any auth check.
          if (path === this.#storageRoot) {
            return text(405, "The storage root container cannot be deleted", {
              allow: this.#allow(path),
            });
          }
          return await this.#authorizeThenAsync(
            store,
            origin,
            path,
            "write",
            agent,
            requestOrigin,
            () => this.#delete(store, origin, path, request, jti),
          );
        default:
          return text(405, "Method Not Allowed", { allow: this.#allow(path) });
      }
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        return text(412, "Precondition Failed");
      }
      if (error instanceof LengthRequiredError) {
        return text(411, "Length Required");
      }
      // A `jti` collision surfaces from inside the write transaction (the row
      // and the write commit or roll back together — see `#consumeJti`).
      if (error instanceof DpopReplayError) {
        return this.#replayed();
      }
      throw error;
    }
  }

  // -- authorization wrappers ------------------------------------------------

  /** Map an access path/mode through WAC, deferring `.acl` resources to Control. */
  #decide(
    store: Store,
    origin: string,
    path: string,
    mode: AccessMode,
    agent: string | undefined,
    requestOrigin: string | undefined,
  ): { granted: boolean; status: 401 | 403 } | null {
    // The pod owner always has full access; this bootstraps `.acl` management.
    if (agent !== undefined && this.#owners.includes(agent)) return null;

    const wacPath = isAclPath(path) ? resourceForAcl(path) : path;
    const wacMode: AccessMode = isAclPath(path) ? "control" : mode;
    const decision = authorize(store, origin, wacPath, {
      mode: wacMode,
      ...(agent ? { agent } : {}),
      ...(requestOrigin ? { origin: requestOrigin } : {}),
    });
    if (decision.granted) return null;
    // Unauthenticated denials prompt authentication (401); authenticated
    // denials are a hard 403.
    return { granted: false, status: agent ? 403 : 401 };
  }

  async #authorizeThenAsync(
    store: Store,
    origin: string,
    path: string,
    mode: AccessMode,
    agent: string | undefined,
    requestOrigin: string | undefined,
    run: () => Promise<Response>,
  ): Promise<Response> {
    const denied = this.#decide(
      store,
      origin,
      path,
      mode,
      agent,
      requestOrigin,
    );
    if (denied) return this.#denied(denied.status);
    return run();
  }

  #denied(status: 401 | 403): Response {
    return text(status, status === 401 ? "Unauthorized" : "Forbidden", {
      ...(status === 401 ? { "www-authenticate": 'DPoP realm="solid"' } : {}),
      // Signal the WAC denial to the front door, which logs it via the injected
      // observability seams and strips this header before replying to the client.
      [INTERNAL_HEADERS.outcome]: PodOutcome.WacDenied,
    });
  }

  /**
   * Forward any blob keys the store outboxed (copy-on-write displacements and
   * deletes) into the shared D1 GC tracking table, so the out-of-band cron can
   * reclaim them without ever waking this Durable Object. No-op when `GC_DB` is
   * not bound.
   */
  async #drainOrphans(store: Store): Promise<void> {
    if (!this.env.GC_DB) return;
    await forwardOrphans(store, d1OrphanSink(this.env.GC_DB));
  }

  // -- DPoP replay -----------------------------------------------------------

  /**
   * Refuse a proof-less write unless the deployment opted into anonymous writes.
   * A tokenless request reaches a write handler only when WAC granted the public
   * agent class; without a DPoP proof there is no `jti`, hence no replay /
   * anti-abuse control, so "DPoP everywhere" requires we reject by default.
   * Returns a `401` challenge to block the write, or `null` to let it proceed.
   */
  #denyAnonymousWrite(jti: string | undefined): Response | null {
    if (jti !== undefined || this.#allowAnonymousWrites) return null;
    return text(401, "DPoP proof required for writes", {
      "www-authenticate": 'DPoP realm="solid", error="invalid_token"',
      [INTERNAL_HEADERS.outcome]: PodOutcome.AnonymousWriteRefused,
    });
  }

  /**
   * Build the in-transaction guard that enforces strict single-use of a write's
   * DPoP `jti`. The store runs it inside the write `transactionSync`, *after*
   * the `If-Match` / `solid:where` preconditions pass, so a `jti` is consumed
   * only when the write actually commits: a failed precondition (412/409) rolls
   * the row back and leaves the proof reusable for a legitimate retry, and a
   * replayed `jti` aborts the write atomically. No-op for an anonymous write
   * (it carries no proof; admission is gated by {@link #denyAnonymousWrite}).
   */
  #replayGuard(jti: string | undefined): () => void {
    return () => this.#consumeJti(jti);
  }

  /** Prune expired rows, reject a duplicate `jti`, then record this one. */
  #consumeJti(jti: string | undefined): void {
    if (!jti) return;
    const nowSec = Math.floor(Date.now() / 1000);
    this.#sql.exec("DELETE FROM dpop_jti WHERE expires_at < ?", nowSec);
    const existing = this.#sql
      .exec<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM dpop_jti WHERE jti = ?", jti)
      .one().n;
    if (existing > 0) throw new DpopReplayError();
    this.#sql.exec(
      "INSERT INTO dpop_jti (jti, expires_at) VALUES (?, ?)",
      jti,
      nowSec + JTI_TTL_SECONDS,
    );
  }

  // -- read ------------------------------------------------------------------

  async #read(
    store: Store,
    origin: string,
    path: string,
    request: Request,
    headOnly: boolean,
    agent: string | undefined,
    requestOrigin: string | undefined,
  ): Promise<Response> {
    const meta = store.head(path);
    if (!meta) return text(404, "Not Found");

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatchSatisfied(ifNoneMatch, meta.etag)) {
      return new Response(null, { status: 304, headers: { etag: meta.etag } });
    }

    // WAC §5.3.5: GET/HEAD MUST advertise the client's privileges (and the
    // public's) via `WAC-Allow`. Computed once and threaded into the header
    // builder for both the blob and RDF responses.
    const wacAllow = this.#wacAllow(store, origin, path, agent, requestOrigin);

    if (meta.kind === "blob") {
      // Streamed straight from R2 — never buffered in the DO.
      return this.#readBlobResponse(
        store,
        path,
        meta.etag,
        meta.contentType,
        headOnly,
        wacAllow,
      );
    }

    const negotiated = negotiateMediaType(request.headers.get("accept"));
    if (negotiated === null) {
      return text(406, "Not Acceptable");
    }

    const stored = store.readQuads(path);
    const quads = stored.map(storedToQuad);
    // LDN discovery: surface any `ldp:inbox` this resource declares as a
    // `Link rel="…ldp#inbox"` so notification senders can find the inbox without
    // parsing the body. RDF-only — the body must point at its own inbox.
    const inboxIris = discoverInboxIris(stored, toIri(origin, path));
    return this.#serializeResponse(
      quads,
      negotiated,
      origin,
      path,
      meta.etag,
      headOnly,
      inboxIris,
      wacAllow,
    );
  }

  /**
   * Compute the `WAC-Allow` header value for a read (WAC §5.3.5). The format is
   * `user="…",public="…"`: the privileges the authenticated agent holds and the
   * privileges any unauthenticated agent holds, each a space-separated list of
   * lowercase mode tokens. The pod owner always holds the full set.
   */
  #wacAllow(
    store: Store,
    origin: string,
    path: string,
    agent: string | undefined,
    requestOrigin: string | undefined,
  ): string {
    // The owner always holds the full set, so we never need to evaluate their
    // modes — only the public's. Otherwise resolve the effective ACL once and
    // evaluate the authenticated agent and the public against it together.
    const empty = (): Set<AccessMode> => new Set<AccessMode>();
    if (agent !== undefined && this.#owners.includes(agent)) {
      const [publicModes = empty()] = grantedModes(
        store,
        origin,
        path,
        [undefined],
        requestOrigin,
      );
      const full = new Set<AccessMode>(["read", "write", "append", "control"]);
      return wacAllowHeader(full, publicModes);
    }
    const [userModes = empty(), publicModes = empty()] = grantedModes(
      store,
      origin,
      path,
      [agent, undefined],
      requestOrigin,
    );
    return wacAllowHeader(userModes, publicModes);
  }

  async #readBlobResponse(
    store: Store,
    path: string,
    etag: string,
    contentType: string,
    headOnly: boolean,
    wacAllow: string,
  ): Promise<Response> {
    const blob = await store.readBlob(path);
    if (!blob) return text(404, "Not Found");
    const headers = baseHeaders(
      path,
      etag,
      blob.contentType || contentType,
      this.#allow(path),
    );
    headers.set("content-length", String(blob.size));
    headers.set("wac-allow", wacAllow);
    if (headOnly) {
      await blob.stream.cancel();
      return new Response(null, { status: 200, headers });
    }
    return new Response(blob.stream, { status: 200, headers });
  }

  async #serializeResponse(
    quads: Quad[],
    negotiated: Negotiated,
    origin: string,
    path: string,
    etag: string,
    headOnly: boolean,
    inboxIris: readonly string[],
    wacAllow: string,
  ): Promise<Response> {
    const body = await serializeRdf(quads, negotiated.mediaType, {
      baseIRI: toIri(origin, path),
      prefixes: SERIALIZE_PREFIXES,
    });
    const headers = baseHeaders(
      path,
      etag,
      negotiated.mediaType,
      this.#allow(path),
      inboxIris,
    );
    headers.set("wac-allow", wacAllow);
    return new Response(headOnly ? null : body, { status: 200, headers });
  }

  // -- put -------------------------------------------------------------------

  async #put(
    store: Store,
    origin: string,
    path: string,
    request: Request,
    jti: string | undefined,
  ): Promise<Response> {
    const blocked = this.#denyAnonymousWrite(jti);
    if (blocked) return blocked;

    const existed = store.head(path) !== null;
    // Both preconditions are threaded into the store write and re-checked
    // inside its transaction, so there is no TOCTOU window here. `existed` is
    // only used to pick the 201/204 status; it is not relied on for safety.
    // The `jti` replay row is consumed in that same transaction (`replayGuard`),
    // so a rejected precondition does not burn the proof.
    await this.#writeBody(store, origin, path, request, {
      ifMatch: ifMatchOf(request),
      ifNoneMatch: ifNoneMatchOf(request),
      guard: this.#replayGuard(jti),
    });
    this.#ensureContainerChain(store, origin, path);
    await this.#drainOrphans(store);

    this.#broadcast(toIri(origin, path), existed ? "Update" : "Create");
    const meta = store.head(path);
    return new Response(null, {
      status: existed ? 204 : 201,
      headers: meta
        ? {
            etag: meta.etag,
            location: toIri(origin, path),
            allow: this.#allow(path),
          }
        : { location: toIri(origin, path), allow: this.#allow(path) },
    });
  }

  // -- post ------------------------------------------------------------------

  async #post(
    store: Store,
    origin: string,
    path: string,
    request: Request,
    jti: string | undefined,
  ): Promise<Response> {
    if (!isContainer(path)) {
      return text(405, "POST target must be a container", {
        allow: this.#allow(path),
      });
    }
    const blocked = this.#denyAnonymousWrite(jti);
    if (blocked) return blocked;

    const asContainer = linkIndicatesContainer(request.headers.get("link"));
    const slug = request.headers.get("slug");
    // Honor an explicit Slug once; on collision fall back to random names.
    let key = childKey(path, slug, asContainer);
    while (store.head(key) !== null) {
      key = childKey(path, null, asContainer);
    }

    // A POST always mints a fresh, non-colliding key, so it is unconditional;
    // the `jti` is still consumed inside the write transaction.
    await this.#writeBody(store, origin, key, request, {
      guard: this.#replayGuard(jti),
    });
    this.#ensureContainerChain(store, origin, key);
    await this.#drainOrphans(store);

    const childIri = toIri(origin, key);
    this.#broadcast(childIri, "Create");
    this.#broadcast(toIri(origin, path), "Update");
    const meta = store.head(key);
    return new Response(null, {
      status: 201,
      headers: meta
        ? { location: childIri, etag: meta.etag, allow: this.#allow(key) }
        : { location: childIri, allow: this.#allow(key) },
    });
  }

  // -- patch -----------------------------------------------------------------

  async #patch(
    store: Store,
    origin: string,
    path: string,
    request: Request,
    agent: string | undefined,
    jti: string | undefined,
    requestOrigin: string | undefined,
  ): Promise<Response> {
    const contentType = request.headers.get("content-type") ?? "";
    const body = await request.text();

    let parsed;
    try {
      parsed = parsePatch(body, contentType, toIri(origin, path));
    } catch (error) {
      // A document-constraint violation (malformed N3, missing type triple,
      // duplicate predicate, blank node or unbound variable in a template) means
      // the patch does not satisfy the N3 Patch document constraints → 422
      // (Solid Protocol §5.3.1, `#server-patch-n3-invalid`).
      if (error instanceof PatchConstraintError) {
        return text(422, `Invalid patch document: ${error.code}`);
      }
      if (error instanceof PatchProblem) {
        return error.code === "unsupported_media_type"
          ? text(415, "Unsupported patch media type")
          : text(400, `Malformed patch: ${error.code}`);
      }
      throw error;
    }

    // Append authorizes insert-only patches; any delete requires Write.
    const mode: AccessMode = parsed.deletes.length > 0 ? "write" : "append";
    const denied = this.#decide(
      store,
      origin,
      path,
      mode,
      agent,
      requestOrigin,
    );
    if (denied) return this.#denied(denied.status);

    const blocked = this.#denyAnonymousWrite(jti);
    if (blocked) return blocked;

    const existed = store.head(path) !== null;
    const current = store.readQuads(path);
    let resolved;
    try {
      resolved = resolvePatch(parsed, current);
    } catch (error) {
      // An unbound template variable surfaced here (the SPARQL path, which has
      // no static check) is a document constraint violation → 422.
      if (error instanceof PatchConstraintError) {
        return text(422, `Invalid patch document: ${error.code}`);
      }
      if (error instanceof PatchProblem) {
        // `where_too_complex` is our own DoS guard, not a Solid-defined
        // condition (a richer-than-supported `where` pattern); we keep it a
        // 400 Bad Request as a non-spec extension. The remaining outcomes —
        // `no_match`, `ambiguous_match`, `delete_not_found` — are binding/state
        // results that mean the patch's precondition does not hold against the
        // current document: 409 Conflict (`#server-patch-n3-semantics`).
        return error.code === "where_too_complex"
          ? text(400, `Patch where pattern too complex: ${error.code}`)
          : text(409, `Patch does not apply: ${error.code}`);
      }
      throw error;
    }

    try {
      store.patchQuads(
        path,
        { deletes: resolved.deletes, inserts: resolved.inserts },
        {
          ifMatch: ifMatchOf(request),
          contentType: "text/turtle",
          guard: this.#replayGuard(jti),
        },
      );
    } catch (error) {
      if (error instanceof PreconditionFailedError)
        return text(412, "Precondition Failed");
      throw error;
    }
    this.#ensureContainerChain(store, origin, path);
    await this.#drainOrphans(store);

    this.#broadcast(toIri(origin, path), existed ? "Update" : "Create");
    const meta = store.head(path);
    return new Response(null, {
      status: existed ? 204 : 201,
      headers: meta
        ? { etag: meta.etag, allow: this.#allow(path) }
        : { allow: this.#allow(path) },
    });
  }

  // -- delete ----------------------------------------------------------------

  async #delete(
    store: Store,
    origin: string,
    path: string,
    request: Request,
    jti: string | undefined,
  ): Promise<Response> {
    const blocked = this.#denyAnonymousWrite(jti);
    if (blocked) return blocked;

    const meta = store.head(path);
    if (!meta) return text(404, "Not Found");

    try {
      store.delete(path, {
        ifMatch: ifMatchOf(request),
        // Re-check container emptiness inside the delete transaction so a
        // concurrent child write cannot slip in between the check and the
        // delete (LDP: a non-empty container MUST NOT be deleted), then consume
        // the `jti` in that same transaction. The emptiness check runs first so
        // a 409 leaves the proof reusable; the `jti` is burned only if the
        // delete commits.
        guard: () => {
          if (
            isContainer(path) &&
            store
              .readQuads(path)
              .some((q) => isContainsQuad(q, toIri(origin, path)))
          ) {
            throw new ContainerNotEmptyError();
          }
          this.#consumeJti(jti);
        },
      });
    } catch (error) {
      if (error instanceof ContainerNotEmptyError) {
        return text(409, "Container is not empty");
      }
      throw error;
    }
    this.#removeContainment(store, origin, path);
    await this.#drainOrphans(store);
    this.#broadcast(toIri(origin, path), "Delete");
    return new Response(null, {
      status: 204,
      headers: { allow: this.#allow(path) },
    });
  }

  // -- options ---------------------------------------------------------------

  #options(path: string): Response {
    return new Response(null, {
      status: 204,
      headers: {
        allow: this.#allow(path),
        "accept-patch": "text/n3, application/sparql-update",
        ...(isContainer(path) ? { "accept-post": ACCEPT_POST } : {}),
      },
    });
  }

  // -- write helpers ---------------------------------------------------------

  #replayed(): Response {
    return text(401, "DPoP proof replay detected", {
      "www-authenticate": 'DPoP error="invalid_token"',
      [INTERNAL_HEADERS.outcome]: PodOutcome.Replay,
    });
  }

  /**
   * Parse RDF into the quad store, or offload an opaque/oversized body to R2 —
   * without ever buffering a full blob in the DO.
   *
   * Routing keys off the declared `Content-Length`: a body known to fit the
   * SQLite-cell ceiling is read into memory (bounded) and, if it is RDF, parsed
   * into quads; anything larger is streamed straight to R2 as an opaque blob.
   * When the length is undeclared we read only up to the ceiling to classify it;
   * a body that overflows that probe cannot be sized to stream safely, so it is
   * rejected (411) rather than risk buffering it whole.
   */
  async #writeBody(
    store: Store,
    origin: string,
    path: string,
    request: Request,
    preconditions: Pick<WriteOptions, "ifMatch" | "ifNoneMatch" | "guard">,
  ): Promise<void> {
    const contentType =
      request.headers.get("content-type")?.split(";")[0]?.trim() ||
      (isContainer(path) ? "text/turtle" : "application/octet-stream");
    const rdfFormat = formatForMediaType(contentType);
    const declared = parseContentLength(request.headers.get("content-length"));

    // Resolve the bytes to keep in memory (small bodies only) versus a body to
    // stream straight to R2. The declared length only fast-paths the
    // known-large case; for everything else we read the *actual* body up to the
    // ceiling rather than trust the header, so a understated `Content-Length`
    // cannot smuggle an oversized body into memory.
    let inlineBytes: Uint8Array | null;
    if (declared !== null && declared > store.maxInlineBytes) {
      // Known-large: stream to R2, never resident in the DO.
      inlineBytes = null;
    } else {
      // Small or undeclared: probe up to the ceiling, trusting nothing.
      const peeked = await readUpToLimit(request.body, store.maxInlineBytes);
      if (peeked.kind === "overflow") {
        // Too big to hold and unsized to stream — demand a Content-Length.
        throw new LengthRequiredError();
      }
      inlineBytes = peeked.bytes;
    }

    if (inlineBytes === null) {
      // Oversized (binary or RDF): stream the body straight through to R2.
      await store.putBlob(path, request.body ?? new Blob([]), {
        contentType,
        ...preconditions,
      });
      return;
    }

    if (!rdfFormat) {
      // Small opaque body: already in hand, write it as a blob.
      await store.putBlob(path, inlineBytes, { contentType, ...preconditions });
      return;
    }

    const bodyText = new TextDecoder().decode(inlineBytes);
    const quads = await parseRdf(bodyText, contentType, {
      baseIRI: toIri(origin, path),
    });
    const stored = quads.map(quadToStored);
    // A container's `ldp:contains` listing is server-managed; clients never
    // send it, so a PUT that replaced all quads would orphan every child.
    // Preserve existing containment (and re-assert the container types).
    const containerIri = toIri(origin, path);
    const preserved =
      isContainer(path) && store.head(path) !== null
        ? store.readQuads(path).filter((q) => isContainsQuad(q, containerIri))
        : [];
    const withType = isContainer(path)
      ? [...stored, ...containerTypeQuads(containerIri), ...preserved]
      : stored;
    await store.putResource(path, inlineBytes, {
      quads: withType,
      contentType,
      ...preconditions,
    });
  }

  // -- containment -----------------------------------------------------------

  /** Ensure every ancestor container of `key` exists and contains its child. */
  #ensureContainerChain(store: Store, origin: string, key: string): void {
    const parent = parentContainer(key);
    if (parent === null) return;

    // `parent` nearest-first up to the root container.
    const chain = [parent, ...ancestorContainers(parent)];

    // Create any missing containers, root-first.
    for (const container of [...chain].reverse()) {
      if (store.head(container) === null) {
        store.writeQuads(
          container,
          containerTypeQuads(toIri(origin, container)),
          {
            contentType: "text/turtle",
          },
        );
      }
    }

    // Link each container into its own parent, then the new resource into its
    // immediate parent. `ldp:contains` inserts are idempotent in the store.
    for (const container of chain) {
      const grandparent = parentContainer(container);
      if (grandparent !== null) {
        this.#setContainment(store, origin, grandparent, container, true);
      }
    }
    // Auxiliary resources (`.acl`/`.meta`) are not contained members per Solid;
    // listing them would leak the existence/paths of ACL documents to anyone
    // with container Read. Skip the containment triple for them.
    if (!hasReservedAuxiliarySuffix(key)) {
      this.#setContainment(store, origin, parent, key, true);
    }
  }

  /** Drop `key` from its parent container's `ldp:contains` listing. */
  #removeContainment(store: Store, origin: string, key: string): void {
    const parent = parentContainer(key);
    if (parent === null || store.head(parent) === null) return;
    this.#setContainment(store, origin, parent, key, false);
  }

  #setContainment(
    store: Store,
    origin: string,
    parent: string,
    child: string,
    present: boolean,
  ): void {
    const parentIri = toIri(origin, parent);
    const childIri = toIri(origin, child);
    const triple = iriQuad(parentIri, `${LDP}contains`, childIri);
    if (present) {
      store.patchQuads(
        parent,
        { deletes: [], inserts: [triple] },
        { contentType: "text/turtle" },
      );
    } else {
      store.patchQuads(
        parent,
        { deletes: [triple], inserts: [] },
        { contentType: "text/turtle" },
      );
    }
  }

  // -- notifications ---------------------------------------------------------

  /**
   * Accept a hibernatable WebSocket subscription. v1 channels carry only the
   * changed resource IRI (no body), and are not WAC-filtered per subscriber —
   * a deliberate, documented simplification.
   */
  #handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Subscriptions are connection-scoped; a ping/keepalive is echoed, anything
    // else is acknowledged so clients can confirm the channel is live.
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  // No `webSocketClose` override: the runtime closes the hibernatable socket
  // itself, and calling `ws.close()` here throws on reserved codes (1006).

  /** Fan a change notification out to every connected subscriber. */
  #broadcast(objectIri: string, type: ChangeType): void {
    const notification = JSON.stringify({
      "@context": ACTIVITYSTREAMS,
      type,
      object: objectIri,
      published: new Date().toISOString(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(notification);
      } catch {
        // A socket that is gone mid-broadcast is harmless; skip it.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const ALLOW = "GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE";

// `#server-delete-protect-root-container`: the storage root container MUST NOT
// be deletable, so its advertised `Allow` omits DELETE (and a DELETE against it
// is refused 405 — see the switch in `fetch`). Every other resource keeps the
// full method set.
const ALLOW_NO_DELETE = "GET, HEAD, OPTIONS, PUT, POST, PATCH";

/** The `Allow` method list for `path`, dropping DELETE for the storage root. */
function allowFor(path: string, storageRoot: string): string {
  return path === storageRoot ? ALLOW_NO_DELETE : ALLOW;
}

/**
 * Concrete RDF media types a container `POST` accepts, advertised on `OPTIONS`.
 * A bare catch-all wildcard is uninformative; listing the guaranteed
 * serializations (plus the wildcard for opaque bodies) lets clients pick a body
 * format they can produce.
 */
const ACCEPT_POST = "text/turtle, application/ld+json, */*";

/**
 * Whether a stored representation's `etag` satisfies an `If-None-Match` header
 * per RFC 7232 §3.2. `*` matches any current representation; otherwise the
 * header is a comma-separated list of entity-tags compared with the *weak*
 * comparison function — the `W/` prefix is ignored, so `W/"x"`, `"x"`, and a
 * list like `"a", "x"` all match the stored `"x"`.
 */
function ifNoneMatchSatisfied(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = opaque(etag);
  return header.split(",").some((tag) => {
    const candidate = opaque(tag);
    return candidate.length > 0 && candidate === target;
  });
}

/** The outcome of {@link readUpToLimit}: a fully-buffered body or an overflow signal. */
type PeekedBody =
  | { readonly kind: "buffered"; readonly bytes: Uint8Array }
  | { readonly kind: "overflow" };

/** Concatenate read chunks into one `Uint8Array` of `total` bytes. */
function concatChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Parse a `Content-Length` header into a non-negative integer, or `null` when
 * it is absent or malformed (treated as "length unknown").
 */
function parseContentLength(header: string | null): number | null {
  // RFC 9110: Content-Length is 1*DIGIT. Reject anything `Number()` would coerce
  // loosely (whitespace, "", "0x10", "1e3", signs); a value past safe-integer
  // range is treated as undeclared so the bounded probe still backstops it.
  if (header === null || !/^\d+$/.test(header)) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read at most `limit` bytes from `body` to classify an undeclared-length body
 * without buffering an oversized one. Returns the buffered bytes if the body
 * ends within `limit`; signals `overflow` (cancelling the body) the moment it
 * exceeds `limit`. A body of exactly `limit` bytes still fits the cell.
 */
async function readUpToLimit(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<PeekedBody> {
  if (!body) return { kind: "buffered", bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { kind: "buffered", bytes: concatChunks(chunks, total) };
    chunks.push(value);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { kind: "overflow" };
    }
  }
}

/** Thrown from a delete guard to abort the transaction for a non-empty LDP container. */
class ContainerNotEmptyError extends Error {}

/** Thrown by `#writeBody` when an unsized body is too large to buffer or stream (→ 411). */
class LengthRequiredError extends Error {}

/**
 * Thrown from a write's replay guard when its DPoP `jti` was already seen. It
 * propagates out of the store's write `transactionSync`, rolling the write back
 * with it, and is mapped to a `401` by {@link SolidPodObject.fetch}.
 */
class DpopReplayError extends Error {}

/**
 * Render a `WAC-Allow` value from the granted-mode sets (WAC §5.3.5):
 * `user="read write …",public="…"`. `write` implies `append`, so an `append`
 * token is emitted whenever `write` is granted. Each group is always quoted,
 * empty or not, in a stable mode order.
 */
function wacAllowHeader(
  userModes: ReadonlySet<AccessMode>,
  publicModes: ReadonlySet<AccessMode>,
): string {
  return `user="${formatModes(userModes)}",public="${formatModes(publicModes)}"`;
}

/** Order and stringify a mode set, expanding the `write ⇒ append` implication. */
function formatModes(modes: ReadonlySet<AccessMode>): string {
  const effective = new Set<AccessMode>(modes);
  if (effective.has("write")) effective.add("append");
  const order: AccessMode[] = ["read", "write", "append", "control"];
  return order.filter((m) => effective.has(m)).join(" ");
}

function baseHeaders(
  path: string,
  etag: string,
  contentType: string,
  allow: string,
  inboxIris: readonly string[] = [],
): Headers {
  const headers = new Headers({
    etag,
    "content-type": contentType,
    "accept-patch": "text/n3, application/sparql-update",
    // Solid `#server-allow-methods`: successful responses advertise the methods
    // the resource supports, the same list used by OPTIONS and the 405 path.
    allow,
  });
  const links = [
    isContainer(path)
      ? `<${LDP}BasicContainer>; rel="type", <${LDP}Resource>; rel="type"`
      : `<${LDP}Resource>; rel="type"`,
    ...inboxIris.map(inboxLinkHeader),
  ];
  headers.set("link", links.join(", "));
  return headers;
}

/** The `rdf:type` triples that make `iri` an LDP basic container. */
function containerTypeQuads(iri: string): StoredQuad[] {
  return [
    iriQuad(iri, RDF_TYPE, `${LDP}Resource`),
    iriQuad(iri, RDF_TYPE, `${LDP}Container`),
    iriQuad(iri, RDF_TYPE, `${LDP}BasicContainer`),
  ];
}

function ifMatchOf(request: Request): string | undefined {
  return request.headers.get("if-match") ?? undefined;
}

function ifNoneMatchOf(request: Request): string | undefined {
  return request.headers.get("if-none-match") ?? undefined;
}

/** Whether a `Link` header marks the POSTed resource as an LDP container. */
function linkIndicatesContainer(link: string | null): boolean {
  if (!link) return false;
  // Split into individual link-values at each "," that introduces a new
  // "<uri>", then require the container type URI and a `rel="type"` parameter
  // to appear in the *same* entry. Checking the header as a whole would let a
  // stray `rel="type"` on one link combine with an unrelated container URI on
  // another to produce a false positive.
  for (const entry of link.split(/,(?=\s*<)/)) {
    const start = entry.indexOf("<");
    const end = entry.indexOf(">", start + 1);
    if (start === -1 || end === -1) continue;
    const uri = entry.slice(start + 1, end).trim();
    if (uri !== `${LDP}Container` && uri !== `${LDP}BasicContainer`) {
      continue;
    }
    if (linkEntryRelIsType(entry.slice(end + 1))) return true;
  }
  return false;
}

/**
 * Whether a link-value's parameter string declares `rel="type"`. Parameters are
 * split on top-level `;` (respecting quoted values) before matching, so a
 * `rel=type` substring inside another parameter's quoted value (e.g.
 * `title="x; rel=type"`) is not mistaken for the rel parameter. `rel` is a
 * space-separated token list, so `rel="type other"` also counts.
 */
function linkEntryRelIsType(params: string): boolean {
  for (const param of splitLinkParams(params)) {
    const match = /^\s*rel\s*=\s*("([^"]*)"|'([^']*)'|[^;\s]+)\s*$/i.exec(
      param,
    );
    if (match === null) continue;
    const value = match[2] ?? match[3] ?? match[1] ?? "";
    if (value.toLowerCase().split(/\s+/).includes("type")) return true;
  }
  return false;
}

/** Split a link-value parameter string on top-level `;`, respecting quotes. */
function splitLinkParams(params: string): string[] {
  const parts: string[] = [];
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < params.length; i++) {
    const char = params[i] as string;
    if (char === '"' && params[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    }
    if (char === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}
