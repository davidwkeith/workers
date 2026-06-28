/**
 * The single storage interface `@dwk/solid-pod` talks to from inside its
 * Durable Object: a DO-SQLite quad store for RDF plus R2 copy-on-write blob
 * bodies, with TOCTOU-free `If-Match` / `If-None-Match` writes and a
 * transactional orphan outbox feeding the out-of-band GC path (see `gc.ts`).
 */

import type { StoredQuad } from "@dwk/rdf";

import {
  SCHEMA,
  quadToRow,
  rowToQuad,
  type QuadRowRecord,
  type ResourceKind,
} from "./sql.js";

/** Where a resource body lives. */
export type StorageTier = "sqlite" | "r2";

/** Cloudflare bindings required to construct a {@link Store}. */
export interface StoreEnv {
  /** R2 bucket holding blob bodies. */
  readonly BLOBS: R2Bucket;
}

/** Tunables for {@link createStore}. */
export interface StoreConfig {
  /**
   * Bodies larger than this (bytes) are routed to R2 as opaque blobs rather
   * than the SQLite quad store. Defaults to the ~2 MB DO-cell ceiling.
   */
  readonly maxInlineBytes?: number;
}

/** Metadata for a resource pointer, without its body. */
export interface ResourceMeta {
  readonly key: string;
  readonly kind: ResourceKind;
  readonly etag: string;
  readonly contentType: string;
  /**
   * Byte size of the resource's stored representation: the blob body for a
   * `blob`, or the byte length passed to {@link Store.putResource} for inline
   * RDF. `0` for resources with no canonical byte body (e.g. containers) or
   * those written before size tracking.
   */
  readonly size: number;
  /** Last-modified time (epoch ms), refreshed on every write. */
  readonly modifiedAt: number;
}

/** A streamed blob body. The `stream` is read straight from R2, never buffered. */
export interface BlobBody {
  readonly stream: ReadableStream;
  readonly etag: string;
  readonly contentType: string;
  readonly size: number;
}

/**
 * A blob body accepted by the write path. A `ReadableStream` or `Blob` is
 * streamed to R2 and hashed without ever being fully buffered in the Durable
 * Object; an in-memory `ArrayBuffer`/`Uint8Array` is written directly (used for
 * the small RDF-offload case, where the bytes are already resident).
 */
export type BlobBodyInit = ReadableStream | Blob | ArrayBuffer | Uint8Array;

/** A delete/insert pair applied atomically by {@link Store.patchQuads}. */
export interface QuadPatch {
  readonly deletes: readonly StoredQuad[];
  readonly inserts: readonly StoredQuad[];
}

/** Common write preconditions. */
export interface WriteOptions {
  /**
   * `If-Match` precondition: the expected current ETag, or `"*"` to require the
   * resource to already exist. Checked and applied in one SQLite transaction so
   * it is TOCTOU-free.
   */
  readonly ifMatch?: string;
  /**
   * `If-None-Match` precondition: `"*"` requires the resource to **not** already
   * exist (create-only); a concrete ETag rejects the write when it matches the
   * current pointer. Like {@link WriteOptions.ifMatch} it is checked inside the
   * same SQLite transaction as the write, so it is TOCTOU-free.
   */
  readonly ifNoneMatch?: string;
  /** Content type recorded on the pointer. */
  readonly contentType?: string;
  /**
   * Byte size of the representation, recorded on the pointer for metadata (e.g.
   * WebDAV `getcontentlength`). The blob write path measures this itself; supply
   * it for inline RDF where the byte length is known but the store sees only
   * quads. Defaults to `0` (resources with no canonical byte body, e.g.
   * containers).
   */
  readonly size?: number;
  /**
   * Invariant or side effect run inside the write transaction, after the
   * `ifMatch` / `ifNoneMatch` checks pass and before any mutation. Throw to
   * abort the write: the transaction rolls back and the error propagates, so
   * anything the guard wrote (e.g. a single-use DPoP-`jti` row) is rolled back
   * together with the write — making the guard and the write atomic.
   */
  readonly guard?: () => void;
}

/** Preconditions for {@link Store.delete}. */
export type DeleteOptions = Pick<WriteOptions, "ifMatch" | "guard">;

/** A pending orphaned R2 key, read from the transactional outbox. */
export interface OrphanRecord {
  readonly id: number;
  readonly blobKey: string;
  readonly enqueuedAt: number;
}

/**
 * A pending "un-orphan" tombstone: a content-addressed key resurrected after
 * its orphan row was already forwarded to the shared GC store. The forwarder
 * propagates it as a delete against the forwarded GC row.
 */
export interface OrphanCancelRecord {
  readonly id: number;
  readonly blobKey: string;
}

/** Storage interface over the DO-SQLite quad store and R2 blob bodies. */
export interface Store {
  /** The byte threshold above which bodies are routed to R2. */
  readonly maxInlineBytes: number;
  /** Decide the tier for a body of `byteLength` bytes. */
  route(byteLength: number): StorageTier;

  /** Read a resource's pointer metadata, or `null` if it does not exist. */
  head(key: string): ResourceMeta | null;

  /**
   * List every resource whose key begins with `prefix`, returning its pointer
   * metadata (no bodies) ordered by key. A protocol-agnostic prefix scan over
   * the opaque key space — the store ascribes no meaning to `/` or to "folders".
   * Callers layer their own hierarchy on top: a remoteStorage handler derives
   * folder listings and aggregate folder ETags from the returned descendants, and
   * an LDP container could enumerate its members the same way instead of
   * maintaining `ldp:contains` triples. `%` and `_` in `prefix` are matched
   * literally (escaped), so a key containing a SQL `LIKE` metacharacter cannot
   * widen the scan.
   */
  list(prefix: string): ResourceMeta[];

  /** Read all quads of an RDF resource (empty if absent or a blob). */
  readQuads(key: string): StoredQuad[];

  /**
   * Replace an RDF resource's quads in one transaction. Returns the new ETag.
   * @throws {PreconditionFailedError} if `ifMatch` does not hold.
   */
  writeQuads(
    key: string,
    quads: readonly StoredQuad[],
    options?: WriteOptions,
  ): string;

  /**
   * Apply an N3-Patch `deletes`+`inserts` to an RDF resource in one
   * transaction. Returns the new ETag.
   * @throws {PreconditionFailedError} if `ifMatch` does not hold.
   */
  patchQuads(key: string, patch: QuadPatch, options?: WriteOptions): string;

  /**
   * Copy-on-write a blob body: write a new content-addressed R2 object, then
   * atomically flip the DO pointer to it and outbox any now-unreferenced
   * predecessor key. Returns the new ETag.
   *
   * A `ReadableStream`/`Blob` body is streamed to R2 and hashed with a
   * `DigestStream` so the full body is never buffered in the DO — satisfying the
   * "stream R2 bodies, never buffer a blob in the DO" mandate even for bodies up
   * to the 128 MB memory limit.
   * @throws {PreconditionFailedError} if `ifMatch` does not hold.
   */
  putBlob(
    key: string,
    body: BlobBodyInit,
    options?: WriteOptions,
  ): Promise<string>;

  /** Stream a blob body from R2, or `null` if the key is absent / not a blob. */
  readBlob(key: string): Promise<BlobBody | null>;

  /**
   * Route a body by size: small RDF (with parsed `quads`) goes to the SQLite
   * quad store; anything over {@link Store.maxInlineBytes} (or without quads)
   * goes to R2 as an opaque blob.
   */
  putResource(
    key: string,
    body: ArrayBuffer | Uint8Array,
    options: WriteOptions & { quads?: readonly StoredQuad[] },
  ): Promise<{ etag: string; tier: StorageTier }>;

  /**
   * Delete a resource. Drops the pointer first, then records any
   * now-unreferenced blob key to the outbox — both in one SQLite transaction.
   * The R2 object itself is reclaimed later by the GC path, never here.
   *
   * An optional `guard` runs inside the same transaction, after the `ifMatch`
   * check but before any mutation; if it throws, the delete is rolled back.
   * Callers use it to enforce delete-time invariants (e.g. LDP container
   * emptiness) without a TOCTOU window between the check and the delete.
   * @throws {PreconditionFailedError} if `ifMatch` does not hold.
   */
  delete(key: string, options?: DeleteOptions): void;

  /** Read not-yet-forwarded orphan rows from the transactional outbox. */
  collectOrphans(limit?: number): OrphanRecord[];

  /**
   * Mark outbox rows as forwarded to the shared GC store at `forwardedAt`. The
   * rows are retained (not deleted) so a later resurrection of the same key can
   * still cancel its forwarded GC row; {@link Store.pruneForwardedOrphans}
   * reclaims them once they age out of the retention window.
   */
  markOrphansForwarded(ids: readonly number[], forwardedAt: number): void;

  /** Delete forwarded outbox rows forwarded at or before `before`. */
  pruneForwardedOrphans(before: number): void;

  /** Read pending resurrection "un-orphan" tombstones. */
  collectCancels(limit?: number): OrphanCancelRecord[];

  /** Remove cancel tombstones once they have been propagated to the GC store. */
  removeForwardedCancels(ids: readonly number[]): void;
}

/** Thrown when an `If-Match` / `If-None-Match` precondition fails (maps to HTTP 412). */
export class PreconditionFailedError extends Error {
  readonly status = 412;
  constructor(key: string) {
    super(`@dwk/store: write precondition failed for "${key}"`);
    this.name = "PreconditionFailedError";
  }
}

/** Default DO SQLite cell ceiling (~2 MB) used to route bodies to R2. */
export const DEFAULT_MAX_INLINE_BYTES = 2 * 1024 * 1024;

const ETAG_QUOTE = '"';

function toBytes(body: ArrayBuffer | Uint8Array): Uint8Array {
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function toHex(digest: ArrayBuffer): string {
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

function randomEtag(): string {
  return `${ETAG_QUOTE}${crypto.randomUUID()}${ETAG_QUOTE}`;
}

interface ResourceRow {
  readonly kind: ResourceKind;
  readonly etag: string;
  readonly contentType: string;
  readonly blobKey: string | null;
  readonly size: number;
  readonly modifiedAt: number;
}

/**
 * Create a {@link Store} backed by a Durable Object's SQLite storage and an R2
 * bucket. Blob keys are namespaced by the DO id so content-addressed dedup and
 * the unreferenced-blob check stay scoped to a single pod.
 *
 * Fails loudly if the required R2 binding is missing — no silent degradation.
 */
export function createStore(
  state: DurableObjectState,
  env: StoreEnv,
  config: StoreConfig = {},
): Store {
  if (!env.BLOBS) {
    throw new Error("@dwk/store: missing required R2 binding `BLOBS`");
  }

  const sql = state.storage.sql;
  for (const ddl of SCHEMA) sql.exec(ddl);
  // Migration: pods created before per-resource `size` tracking predate the
  // column. Add it idempotently (CREATE TABLE IF NOT EXISTS won't alter an
  // existing table). Existing rows default to 0, which is the right "unknown
  // size" for already-stored resources.
  const resourceColumns = sql
    .exec<{ name: string }>("PRAGMA table_info(resources)")
    .toArray();
  if (!resourceColumns.some((column) => column.name === "size")) {
    sql.exec(
      "ALTER TABLE resources ADD COLUMN size INTEGER NOT NULL DEFAULT 0",
    );
  }

  const maxInlineBytes = config.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const blobPrefix = `${state.id.toString()}/blobs`;

  function readResourceRow(key: string): ResourceRow | null {
    const rows = sql
      .exec<{
        kind: string;
        etag: string;
        content_type: string;
        blob_key: string | null;
        size: number;
        updated_at: number;
      }>(
        "SELECT kind, etag, content_type, blob_key, size, updated_at FROM resources WHERE key = ?",
        key,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    return {
      kind: row.kind as ResourceKind,
      etag: row.etag,
      contentType: row.content_type,
      blobKey: row.blob_key,
      size: row.size,
      modifiedAt: row.updated_at,
    };
  }

  /**
   * Enforce `If-Match` / `If-None-Match` preconditions against the current
   * pointer. Always called inside the write `transactionSync`, so the check and
   * the write commit together with no TOCTOU window.
   */
  function assertPreconditions(
    key: string,
    current: ResourceRow | null,
    options: Pick<WriteOptions, "ifMatch" | "ifNoneMatch">,
  ) {
    const { ifMatch, ifNoneMatch } = options;
    if (
      ifMatch !== undefined &&
      (current === null || (ifMatch !== "*" && current.etag !== ifMatch))
    ) {
      throw new PreconditionFailedError(key);
    }
    if (ifNoneMatch !== undefined && current !== null) {
      // `*` forbids any existing resource (create-only); a concrete ETag only
      // conflicts when it matches the current pointer.
      if (ifNoneMatch === "*" || current.etag === ifNoneMatch) {
        throw new PreconditionFailedError(key);
      }
    }
  }

  /**
   * Stream a blob body to R2 without ever buffering it in the DO, returning its
   * content hash. Each step is a single-consumer stream so R2 backpressure
   * governs the flow — no `tee`, whose faster branch could buffer the whole body
   * in the DO:
   *
   *   1. stream the body straight to a random staging key (R2 throttles it);
   *   2. read the staged object back through a `DigestStream` (a WritableStream
   *      that retains no data) to compute its content hash;
   *   3. promote the staged object to its content-addressed key — skipped when
   *      an identical body already exists, so writes still dedupe.
   *
   * R2 has no server-side copy, so the promotion re-streams through the Worker;
   * that is still bounded and never fully buffered.
   *
   * No `httpMetadata.contentType` is recorded on the R2 object: the key is
   * content-addressed, so distinct resources with the same bytes share one
   * object, and a per-object content type would be whatever the last writer set —
   * corrupting a direct-bucket read of another resource. The authoritative
   * content type lives on the per-resource pointer; reads go through the Worker.
   */
  async function stageAndHash(
    stream: ReadableStream,
  ): Promise<{ hash: string; size: number }> {
    const stagingKey = `${blobPrefix}/staging/${crypto.randomUUID()}`;
    try {
      // 1. Stream to staging. A single consumer (R2) means upload backpressure
      //    propagates to the source, so the DO holds only chunks in flight.
      await env.BLOBS.put(stagingKey, stream);
      // 2. Hash by streaming the staged object back through a DigestStream.
      const staged = await env.BLOBS.get(stagingKey);
      if (!staged) {
        throw new Error("@dwk/store: staged blob disappeared before hashing");
      }
      // R2 reports the staged object's byte size without buffering it here.
      const size = staged.size;
      const digest = new crypto.DigestStream("SHA-256");
      await staged.body.pipeTo(digest);
      const hash = toHex(await digest.digest);
      // 3. Promote to the content-addressed key, deduping on an existing body.
      const blobKey = `${blobPrefix}/sha256-${hash}`;
      if ((await env.BLOBS.head(blobKey)) === null) {
        const toCopy = await env.BLOBS.get(stagingKey);
        if (!toCopy) {
          throw new Error(
            "@dwk/store: staged blob disappeared before promotion",
          );
        }
        await env.BLOBS.put(blobKey, toCopy.body);
      }
      return { hash, size };
    } finally {
      // The staged object is transient regardless of outcome.
      await env.BLOBS.delete(stagingKey);
    }
  }

  /** Write a blob body to its content-addressed R2 key, returning hash + size. */
  async function writeBlobObject(
    body: BlobBodyInit,
  ): Promise<{ hash: string; size: number }> {
    if (body instanceof ReadableStream || body instanceof Blob) {
      const stream = body instanceof Blob ? body.stream() : body;
      return stageAndHash(stream);
    }
    // Already-resident bytes (small RDF offload): hash and write directly.
    const bytes = toBytes(body);
    const hash = await sha256Hex(bytes);
    await env.BLOBS.put(`${blobPrefix}/sha256-${hash}`, bytes);
    return { hash, size: bytes.byteLength };
  }

  /** Outbox a blob key iff no surviving resource still points at it. */
  function outboxIfUnreferenced(blobKey: string) {
    const { n } = sql
      .exec<{
        n: number;
      }>("SELECT COUNT(*) AS n FROM resources WHERE blob_key = ?", blobKey)
      .one();
    if (n === 0) {
      sql.exec(
        "INSERT INTO orphan_outbox (blob_key, enqueued_at) VALUES (?, ?)",
        blobKey,
        Date.now(),
      );
    }
  }

  function insertQuads(key: string, quads: readonly StoredQuad[]) {
    for (const quad of quads) {
      sql.exec(
        `INSERT OR IGNORE INTO quads
           (resource, s_type, s_value, p_value, o_type, o_value, o_datatype, o_language, g_type, g_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...quadToRow(key, quad),
      );
    }
  }

  function deleteQuad(key: string, quad: StoredQuad) {
    const [
      ,
      s_type,
      s_value,
      p_value,
      o_type,
      o_value,
      o_datatype,
      o_language,
      g_type,
      g_value,
    ] = quadToRow(key, quad);
    sql.exec(
      `DELETE FROM quads WHERE resource = ?
         AND s_type = ? AND s_value = ? AND p_value = ?
         AND o_type = ? AND o_value = ? AND o_datatype = ? AND o_language = ?
         AND g_type = ? AND g_value = ?`,
      key,
      s_type,
      s_value,
      p_value,
      o_type,
      o_value,
      o_datatype,
      o_language,
      g_type,
      g_value,
    );
  }

  function upsertRdfPointer(
    key: string,
    etag: string,
    contentType: string,
    size: number,
  ) {
    sql.exec(
      `INSERT INTO resources (key, kind, etag, content_type, blob_key, updated_at, size)
       VALUES (?, 'rdf', ?, ?, NULL, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         kind = 'rdf', etag = excluded.etag,
         content_type = excluded.content_type, blob_key = NULL,
         updated_at = excluded.updated_at, size = excluded.size`,
      key,
      etag,
      contentType,
      Date.now(),
      size,
    );
  }

  const store: Store = {
    maxInlineBytes,

    route(byteLength) {
      return byteLength > maxInlineBytes ? "r2" : "sqlite";
    },

    head(key) {
      const row = readResourceRow(key);
      if (!row) return null;
      return {
        key,
        kind: row.kind,
        etag: row.etag,
        contentType: row.contentType,
        size: row.size,
        modifiedAt: row.modifiedAt,
      };
    },

    list(prefix) {
      // Escape `LIKE` metacharacters (`\`, `%`, `_`) so a key containing one is
      // matched literally rather than as a wildcard; pair with `ESCAPE '\'`.
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      return sql
        .exec<{
          key: string;
          kind: string;
          etag: string;
          content_type: string;
          size: number;
          updated_at: number;
        }>(
          `SELECT key, kind, etag, content_type, size, updated_at FROM resources
           WHERE key LIKE ? ESCAPE '\\' ORDER BY key`,
          `${escaped}%`,
        )
        .toArray()
        .map((row) => ({
          key: row.key,
          kind: row.kind as ResourceKind,
          etag: row.etag,
          contentType: row.content_type,
          size: row.size,
          modifiedAt: row.updated_at,
        }));
    },

    readQuads(key) {
      return sql
        .exec<QuadRowRecord>(
          `SELECT s_type, s_value, p_value, o_type, o_value, o_datatype, o_language, g_type, g_value
           FROM quads WHERE resource = ?`,
          key,
        )
        .toArray()
        .map(rowToQuad);
    },

    writeQuads(key, quads, options = {}) {
      const etag = randomEtag();
      const contentType = options.contentType ?? "text/turtle";
      state.storage.transactionSync(() => {
        const current = readResourceRow(key);
        assertPreconditions(key, current, options);
        options.guard?.();
        // Replacing RDF with RDF: if the previous body was a blob, its key may
        // become orphaned.
        if (current?.kind === "blob" && current.blobKey) {
          sql.exec("DELETE FROM resources WHERE key = ?", key);
          outboxIfUnreferenced(current.blobKey);
        }
        sql.exec("DELETE FROM quads WHERE resource = ?", key);
        upsertRdfPointer(key, etag, contentType, options.size ?? 0);
        insertQuads(key, quads);
      });
      return etag;
    },

    patchQuads(key, patch, options = {}) {
      const etag = randomEtag();
      state.storage.transactionSync(() => {
        const current = readResourceRow(key);
        assertPreconditions(key, current, options);
        options.guard?.();
        if (current?.kind === "blob" && current.blobKey) {
          // A patch only makes sense against RDF; drop the blob pointer first.
          sql.exec("DELETE FROM resources WHERE key = ?", key);
          outboxIfUnreferenced(current.blobKey);
        }
        for (const quad of patch.deletes) deleteQuad(key, quad);
        insertQuads(key, patch.inserts);
        upsertRdfPointer(
          key,
          etag,
          options.contentType ?? current?.contentType ?? "text/turtle",
          // A patch rewrites quads with no new byte representation; keep the
          // last known size — but only when the predecessor was itself RDF, so a
          // blob→RDF transition does not inherit the blob's unrelated size.
          options.size ?? (current?.kind === "rdf" ? current.size : 0),
        );
      });
      return etag;
    },

    async putBlob(key, body, options = {}) {
      const contentType = options.contentType ?? "application/octet-stream";

      // Pre-check the precondition against the current pointer *before* writing
      // to R2: a deterministic precondition failure must reject without landing
      // an object, since the full-sweep-free GC can only reclaim keys reported
      // via the outbox at write/delete time. This read is non-authoritative; the
      // in-transaction check below remains the TOCTOU-free authority.
      assertPreconditions(key, readResourceRow(key), options);

      // 1. Write the new content-addressed object first. Streamed bodies are
      //    hashed without ever being buffered in the DO. The content hash is the
      //    R2 key (so identical bytes dedupe to one object), but the ETag is a
      //    fresh per-write opaque validator — a content-addressed ETag would
      //    collide across distinct resources sharing the same bytes, so an
      //    `If-Match` against one could be satisfied by an unrelated other.
      const { hash, size } = await writeBlobObject(body);
      const blobKey = `${blobPrefix}/sha256-${hash}`;
      const etag = randomEtag();

      // 2. Atomically flip the pointer and outbox the displaced key.
      try {
        state.storage.transactionSync(() => {
          const current = readResourceRow(key);
          assertPreconditions(key, current, options);
          options.guard?.();
          sql.exec("DELETE FROM quads WHERE resource = ?", key);
          sql.exec(
            `INSERT INTO resources (key, kind, etag, content_type, blob_key, updated_at, size)
             VALUES (?, 'blob', ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               kind = 'blob', etag = excluded.etag,
               content_type = excluded.content_type, blob_key = excluded.blob_key,
               updated_at = excluded.updated_at, size = excluded.size`,
            key,
            etag,
            contentType,
            blobKey,
            Date.now(),
            size,
          );
          // Resurrection guard: this content-addressed key is referenced again.
          // Cancel its orphan record so GC cannot reclaim a now-live object.
          // A not-yet-forwarded outbox row can simply be dropped; a row already
          // forwarded to the shared GC store also needs an "un-orphan" tombstone
          // so the forwarder deletes the forwarded GC row before the cron GC runs.
          const orphanRows = sql
            .exec<{
              forwarded_at: number | null;
            }>(
              "SELECT forwarded_at FROM orphan_outbox WHERE blob_key = ?",
              blobKey,
            )
            .toArray();
          if (orphanRows.some((r) => r.forwarded_at !== null)) {
            sql.exec(
              "INSERT OR IGNORE INTO orphan_cancels (blob_key) VALUES (?)",
              blobKey,
            );
          }
          sql.exec("DELETE FROM orphan_outbox WHERE blob_key = ?", blobKey);
          if (
            current?.kind === "blob" &&
            current.blobKey &&
            current.blobKey !== blobKey
          ) {
            outboxIfUnreferenced(current.blobKey);
          }
        });
      } catch (err) {
        // The transaction rolled back after the object had already landed in
        // R2 — a concurrent write moved the pointer and the authoritative check
        // rejected, or any other failure aborted the write. Either way the
        // pointer never flipped to blobKey, so (unless a live resource still
        // references the same content) it is now an orphan the full-sweep-free
        // GC cannot discover. Record it to the outbox so GC can reclaim it.
        // Best-effort: suppress a secondary failure so it cannot mask `err`.
        try {
          state.storage.transactionSync(() => outboxIfUnreferenced(blobKey));
        } catch {
          // ignore — rethrow the original error below
        }
        throw err;
      }
      return etag;
    },

    async readBlob(key) {
      const row = readResourceRow(key);
      if (!row || row.kind !== "blob" || !row.blobKey) return null;
      const object = await env.BLOBS.get(row.blobKey);
      if (!object) return null;
      return {
        stream: object.body,
        etag: row.etag,
        contentType: row.contentType,
        size: object.size,
      };
    },

    async putResource(key, body, options) {
      const bytes = toBytes(body);
      if (options.quads && store.route(bytes.byteLength) === "sqlite") {
        // Record the source byte length so `getcontentlength`-style metadata is
        // available for inline RDF (the store otherwise sees only quads).
        const etag = store.writeQuads(key, options.quads, {
          ...options,
          size: bytes.byteLength,
        });
        return { etag, tier: "sqlite" };
      }
      const etag = await store.putBlob(key, bytes, options);
      return { etag, tier: "r2" };
    },

    delete(key, options = {}) {
      state.storage.transactionSync(() => {
        const current = readResourceRow(key);
        assertPreconditions(key, current, options);
        if (!current) return;
        // Caller invariant (e.g. container emptiness), checked in-transaction.
        options.guard?.();
        // Drop the pointer first ...
        sql.exec("DELETE FROM resources WHERE key = ?", key);
        sql.exec("DELETE FROM quads WHERE resource = ?", key);
        // ... then report the now-orphaned blob in the same transaction.
        if (current.kind === "blob" && current.blobKey) {
          outboxIfUnreferenced(current.blobKey);
        }
      });
    },

    collectOrphans(limit = 100) {
      return sql
        .exec<{ id: number; blob_key: string; enqueued_at: number }>(
          `SELECT id, blob_key, enqueued_at FROM orphan_outbox
           WHERE forwarded_at IS NULL ORDER BY id LIMIT ?`,
          limit,
        )
        .toArray()
        .map((row) => ({
          id: row.id,
          blobKey: row.blob_key,
          enqueuedAt: row.enqueued_at,
        }));
    },

    markOrphansForwarded(ids, forwardedAt) {
      state.storage.transactionSync(() => {
        for (const id of ids) {
          sql.exec(
            "UPDATE orphan_outbox SET forwarded_at = ? WHERE id = ?",
            forwardedAt,
            id,
          );
        }
      });
    },

    pruneForwardedOrphans(before) {
      sql.exec(
        "DELETE FROM orphan_outbox WHERE forwarded_at IS NOT NULL AND forwarded_at <= ?",
        before,
      );
    },

    collectCancels(limit = 100) {
      return sql
        .exec<{ id: number; blob_key: string }>(
          "SELECT id, blob_key FROM orphan_cancels ORDER BY id LIMIT ?",
          limit,
        )
        .toArray()
        .map((row) => ({ id: row.id, blobKey: row.blob_key }));
    },

    removeForwardedCancels(ids) {
      state.storage.transactionSync(() => {
        for (const id of ids) {
          sql.exec("DELETE FROM orphan_cancels WHERE id = ?", id);
        }
      });
    },
  };

  return store;
}
