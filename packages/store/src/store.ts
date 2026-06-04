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
} from "./sql";

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
}

/** A streamed blob body. The `stream` is read straight from R2, never buffered. */
export interface BlobBody {
  readonly stream: ReadableStream;
  readonly etag: string;
  readonly contentType: string;
  readonly size: number;
}

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
}

/** Preconditions for {@link Store.delete}. */
export interface DeleteOptions extends Pick<WriteOptions, "ifMatch"> {
  /**
   * Invariant checked inside the delete transaction, after `ifMatch` and before
   * any mutation. Throw to abort the delete (the transaction rolls back and the
   * error propagates); the thrown error is the caller's to map to a response.
   */
  readonly guard?: () => void;
}

/** A pending orphaned R2 key, read from the transactional outbox. */
export interface OrphanRecord {
  readonly id: number;
  readonly blobKey: string;
  readonly enqueuedAt: number;
}

/** Storage interface over the DO-SQLite quad store and R2 blob bodies. */
export interface Store {
  /** The byte threshold above which bodies are routed to R2. */
  readonly maxInlineBytes: number;
  /** Decide the tier for a body of `byteLength` bytes. */
  route(byteLength: number): StorageTier;

  /** Read a resource's pointer metadata, or `null` if it does not exist. */
  head(key: string): ResourceMeta | null;

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
   * @throws {PreconditionFailedError} if `ifMatch` does not hold.
   */
  putBlob(
    key: string,
    body: ArrayBuffer | Uint8Array,
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

  /** Read pending orphan rows from the transactional outbox. */
  collectOrphans(limit?: number): OrphanRecord[];

  /** Remove outbox rows once their keys have been forwarded to the GC store. */
  removeForwardedOrphans(ids: readonly number[]): void;
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function randomEtag(): string {
  return `${ETAG_QUOTE}${crypto.randomUUID()}${ETAG_QUOTE}`;
}

interface ResourceRow {
  readonly kind: ResourceKind;
  readonly etag: string;
  readonly contentType: string;
  readonly blobKey: string | null;
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

  const maxInlineBytes = config.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const blobPrefix = `${state.id.toString()}/blobs`;

  function readResourceRow(key: string): ResourceRow | null {
    const rows = sql
      .exec<{
        kind: string;
        etag: string;
        content_type: string;
        blob_key: string | null;
      }>(
        "SELECT kind, etag, content_type, blob_key FROM resources WHERE key = ?",
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

  function upsertRdfPointer(key: string, etag: string, contentType: string) {
    sql.exec(
      `INSERT INTO resources (key, kind, etag, content_type, blob_key, updated_at)
       VALUES (?, 'rdf', ?, ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         kind = 'rdf', etag = excluded.etag,
         content_type = excluded.content_type, blob_key = NULL,
         updated_at = excluded.updated_at`,
      key,
      etag,
      contentType,
      Date.now(),
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
      };
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
        // Replacing RDF with RDF: if the previous body was a blob, its key may
        // become orphaned.
        if (current?.kind === "blob" && current.blobKey) {
          sql.exec("DELETE FROM resources WHERE key = ?", key);
          outboxIfUnreferenced(current.blobKey);
        }
        sql.exec("DELETE FROM quads WHERE resource = ?", key);
        upsertRdfPointer(key, etag, contentType);
        insertQuads(key, quads);
      });
      return etag;
    },

    patchQuads(key, patch, options = {}) {
      const etag = randomEtag();
      state.storage.transactionSync(() => {
        const current = readResourceRow(key);
        assertPreconditions(key, current, options);
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
        );
      });
      return etag;
    },

    async putBlob(key, body, options = {}) {
      const bytes = toBytes(body);
      const hash = await sha256Hex(bytes);
      const blobKey = `${blobPrefix}/sha256-${hash}`;
      const etag = `${ETAG_QUOTE}sha256-${hash}${ETAG_QUOTE}`;
      const contentType = options.contentType ?? "application/octet-stream";

      // Pre-check the precondition against the current pointer *before* writing
      // to R2: a deterministic precondition failure must reject without landing
      // an object, since the full-sweep-free GC can only reclaim keys reported
      // via the outbox at write/delete time. This read is non-authoritative; the
      // in-transaction check below remains the TOCTOU-free authority.
      assertPreconditions(key, readResourceRow(key), options);

      // 1. Write the new content-addressed object first, recording the content
      //    type on the R2 object for direct/public bucket access.
      await env.BLOBS.put(blobKey, bytes, {
        httpMetadata: { contentType },
      });

      // 2. Atomically flip the pointer and outbox the displaced key.
      try {
        state.storage.transactionSync(() => {
          const current = readResourceRow(key);
          assertPreconditions(key, current, options);
          sql.exec("DELETE FROM quads WHERE resource = ?", key);
          sql.exec(
            `INSERT INTO resources (key, kind, etag, content_type, blob_key, updated_at)
             VALUES (?, 'blob', ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               kind = 'blob', etag = excluded.etag,
               content_type = excluded.content_type, blob_key = excluded.blob_key,
               updated_at = excluded.updated_at`,
            key,
            etag,
            contentType,
            blobKey,
            Date.now(),
          );
          // Resurrection guard: this key is referenced again, so cancel any
          // not-yet-forwarded outbox entry for it.
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
        // A concurrent write moved the pointer between the pre-check and the
        // transaction, so the authoritative check rejected after the object had
        // already landed. Record the just-written key to the outbox (unless a
        // live resource still references it) so GC can reclaim it.
        if (err instanceof PreconditionFailedError) {
          state.storage.transactionSync(() => outboxIfUnreferenced(blobKey));
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
        const etag = store.writeQuads(key, options.quads, options);
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
          "SELECT id, blob_key, enqueued_at FROM orphan_outbox ORDER BY id LIMIT ?",
          limit,
        )
        .toArray()
        .map((row) => ({
          id: row.id,
          blobKey: row.blob_key,
          enqueuedAt: row.enqueued_at,
        }));
    },

    removeForwardedOrphans(ids) {
      for (const id of ids) {
        sql.exec("DELETE FROM orphan_outbox WHERE id = ?", id);
      }
    },
  };

  return store;
}
