/**
 * Injected configuration, the `Env` binding fragment, and the storage seam
 * (`WebdavBackend`) for `@dwk/webdav` — spec "Composition & bindings".
 *
 * Per the composition contract a package MUST NOT read the global environment
 * directly: all policy is passed into {@link createWebdav} and the Cloudflare
 * bindings are declared as a TypeScript `Env` fragment. The `WebdavBackend`
 * port is the deliberate **Durable Object seam**: the WebDAV verb router is pure
 * protocol translation over it, and the concrete adapter that resolves the port
 * onto the per-pod `SolidPodObject` (where lock + app-password state live in DO
 * SQLite alongside the Solid write path, spec §2) is supplied by the composing
 * Worker. Keeping the seam injectable is what lets the handler unit-test without
 * standing up the whole pod DO.
 */

import type { AcquireParams, AcquireResult, LockRecord } from "./locks.js";
import type { VerifyResult } from "./credential-store.js";

/**
 * The lock operations the router needs, satisfied by {@link LockStore} running
 * over the per-pod DO's SQLite (spec §2). Sync because DO SQLite is.
 */
export interface LockApi {
  locksOn(path: string): LockRecord[];
  findByToken(token: string): LockRecord | null;
  blockingLock(
    path: string,
    submittedTokens: readonly string[],
  ): LockRecord | null;
  acquire(params: AcquireParams): AcquireResult;
  refresh(token: string, timeoutSeconds: number): LockRecord | null;
  unlock(token: string): boolean;
}

/** The credential verification the auth bridge needs (spec §1). */
export interface CredentialApi {
  verify(credentialId: string, secret: string): Promise<VerifyResult>;
}

/** A stored dead property (RFC 4918 §4) — spec §4. */
export interface DeadProperty {
  /** Namespace URI, or `null` for a no-namespace property (litmus `propnullns`). */
  readonly ns: string | null;
  readonly local: string;
  /** The property element's inner content as a serialized XML fragment. */
  readonly valueXml: string;
}

/**
 * The dead-property operations the router needs, satisfied by `PropertyStore`
 * over the per-pod DO's SQLite (spec §4). Sync because DO SQLite is. Carrying
 * properties across COPY/MOVE and dropping them on DELETE is the backend
 * adapter's job (`PropertyStore.copyTree`/`removeTree`), not the router's —
 * those verbs are implemented behind the seam.
 */
export interface DeadPropertyApi {
  list(path: string): DeadProperty[];
  set(path: string, prop: DeadProperty): void;
  remove(path: string, ns: string | null, local: string): void;
}

/** Access modes a request exercises; mapped onto WAC at authorization time. */
export type WebdavMode = "read" | "write";

/** A resource as the backend sees it — the data PROPFIND/HEAD/GET project. */
export interface ResourceStat {
  /** Path (percent-encoded, container paths end in `/`), e.g. `/photos/a.jpg`. */
  readonly path: string;
  /** A WebDAV collection (LDP container) vs. a non-collection resource. */
  readonly collection: boolean;
  /** Opaque strong validator, including its surrounding quotes. */
  readonly etag: string;
  /** Stored media type (already content-type-inferred on write). */
  readonly contentType: string;
  /** Byte length of the body; `0` for collections. */
  readonly contentLength: number;
  /** Last-modified epoch ms. */
  readonly lastModified: number;
  /** Creation epoch ms, when the backend tracks it. */
  readonly createdAt?: number;
}

/** A streamed read result — the R2 body is never buffered (spec design rule). */
export interface ResourceBody {
  readonly stat: ResourceStat;
  readonly body: ReadableStream<Uint8Array>;
}

/** Preconditions threaded into a mutating backend call (TOCTOU-free in the DO). */
export interface WritePreconditions {
  /** `If-Match` ETag, or `"*"` to require existence. */
  readonly ifMatch?: string;
  /** `If-None-Match` ETag, or `"*"` to require absence (create-only). */
  readonly ifNoneMatch?: string;
}

/** Outcome of a mutating backend call. */
export interface WriteOutcome {
  /** Whether the target existed before the call (drives 201 vs. 204). */
  readonly created: boolean;
  /** The resulting resource's ETag, when one applies. */
  readonly etag?: string;
}

/**
 * The storage + lock + credential operations the WebDAV router needs from the
 * pod. The recommended adapter resolves these onto the per-pod `SolidPodObject`;
 * a standalone deployment MAY back them with a thin `@dwk/store` DO (spec
 * "Standalone fallback"). Every method operates on percent-encoded paths and
 * MUST fail loudly when a required binding is missing.
 */
export interface WebdavBackend {
  /** Metadata for one resource, or `null` when it does not exist. */
  stat(path: string): Promise<ResourceStat | null>;
  /** Immediate children of a collection (auxiliary resources excluded). */
  listChildren(path: string): Promise<readonly ResourceStat[]>;
  /** Stream a resource body; `null` when absent or a collection. */
  read(path: string): Promise<ResourceBody | null>;
  /**
   * Create or replace a resource. `contentLength` is the client's declared
   * `Content-Length` (or `null` when absent); a backend that size-routes a body
   * (inline vs. streamed) needs it so a large, correctly-sized `PUT` is not
   * rejected for want of a length.
   */
  write(
    path: string,
    body: ReadableStream<Uint8Array> | null,
    contentType: string,
    preconditions: WritePreconditions,
    contentLength?: number | null,
  ): Promise<WriteOutcome>;
  /** Create a collection (`MKCOL`). */
  makeCollection(path: string): Promise<WriteOutcome>;
  /**
   * Remove a resource, or a collection and its whole subtree — collection
   * `DELETE` acts as if `Depth: infinity` (RFC 4918 §9.6.1). Preconditions
   * apply to the named target itself.
   */
  remove(path: string, preconditions: WritePreconditions): Promise<void>;
  /** Copy `from`→`to`; collections honour `depth`. */
  copy(
    from: string,
    to: string,
    depth: "0" | "infinity",
    overwrite: boolean,
  ): Promise<WriteOutcome>;
  /** Move `from`→`to`; collections honour `depth`. */
  move(
    from: string,
    to: string,
    depth: "0" | "infinity",
    overwrite: boolean,
  ): Promise<WriteOutcome>;
  /**
   * Whether `webid` may exercise `mode` on `path` per WAC. Effective access is
   * always `app-password scope ∩ WAC` — this is the WAC half (spec §1).
   */
  authorize(webid: string, path: string, mode: WebdavMode): Promise<boolean>;
  /** The Class 2 lock store (DO SQLite). */
  readonly locks: LockApi;
  /** The app-password verification store (DO SQLite). */
  readonly credentials: CredentialApi;
  /** The dead-property store (DO SQLite, spec §4). */
  readonly properties: DeadPropertyApi;
}

/** A thrown precondition failure the router renders as `412 Precondition Failed`. */
export class PreconditionFailed extends Error {
  constructor(message = "precondition failed") {
    super(message);
    this.name = "PreconditionFailed";
  }
}

/** A thrown conflict the router renders as `409 Conflict` (e.g. missing parent). */
export class ResourceConflict extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ResourceConflict";
  }
}

/** A thrown non-empty-collection error rendered as `409 Conflict`. */
export class CollectionNotEmpty extends ResourceConflict {
  constructor(message = "collection not empty") {
    super(message);
    this.name = "CollectionNotEmpty";
  }
}

/** App-password issuance/verification policy. */
export interface AppPasswordPolicy {
  /** PBKDF2 iterations new credentials are minted with. */
  readonly iterations?: number;
  /** Failed-attempt ceiling before a credential is throttled. */
  readonly maxFailedAttempts?: number;
  /** Throttle window in ms (failures decay after this). */
  readonly throttleWindowMs?: number;
}

/** Class 2 lock policy (spec §2). */
export interface LockPolicy {
  /** Default lock lifetime when the client sends no `Timeout`, in seconds. */
  readonly defaultTimeoutSeconds?: number;
  /** Hard ceiling on a requested `Timeout`, in seconds. */
  readonly maxTimeoutSeconds?: number;
  /**
   * Maximum path depth at which a `Depth: infinity` collection lock is allowed.
   * `infinity` locks on the storage root are always forbidden; above this many
   * path segments they are rejected `403` (spec §2 "bounded, not open-ended").
   */
  readonly maxInfinityDepth?: number;
}

/** The injected configuration for {@link createWebdav}. */
export interface WebdavConfig {
  /** Pod origin + base path, e.g. `https://pod.example`. */
  readonly baseUrl: string;
  /** Path prefix the façade is mounted under (default `/`). */
  readonly mountPath?: string;
  /** Builds the storage seam from the request-time bindings (fails loudly). */
  readonly backend: (env: WebdavEnv) => WebdavBackend;
  readonly appPassword?: AppPasswordPolicy;
  readonly lock?: LockPolicy;
  /**
   * Optional OS-litter denylist (off by default): when set, matching `PUT`s are
   * refused and matching names omitted from listings (spec §3).
   */
  readonly denyOsLitter?: boolean | readonly RegExp[];
  /** Clock injection for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The Cloudflare bindings `@dwk/webdav` declares. The concrete backend adapter
 * consumes these; the union with every other mounted package forms the composed
 * `Env`. A deployment that shares the pod DO binds `POD`; the R2 bucket and the
 * app-password pepper are the backend's to validate.
 */
export interface WebdavEnv {
  /** The per-pod Durable Object namespace this façade fronts (spec §2). */
  readonly POD?: DurableObjectNamespace;
  /** The R2 bucket holding blob bodies (the pod's bucket). */
  readonly BLOBS?: R2Bucket;
  /** App-password hashing pepper / parameters secret. */
  readonly WEBDAV_PEPPER?: string;
}

/** Resolved, defaulted lock policy used internally by the router and store. */
export interface ResolvedLockPolicy {
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
  readonly maxInfinityDepth: number;
}

/** Apply lock-policy defaults. */
export function resolveLockPolicy(policy?: LockPolicy): ResolvedLockPolicy {
  return {
    defaultTimeoutSeconds: policy?.defaultTimeoutSeconds ?? 3600,
    maxTimeoutSeconds: policy?.maxTimeoutSeconds ?? 86_400,
    maxInfinityDepth: policy?.maxInfinityDepth ?? 4,
  };
}
