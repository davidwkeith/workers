/**
 * `KVNamespace` → SQLite (or in-memory) shim.
 *
 * By the consistency rules, KV is **only** ever used for safe-to-be-stale caches
 * — never authz or correctness — so a strongly-consistent local backing is a
 * pure upgrade: the "≈60 s eventual" caveat simply does not apply. The shim is a
 * trivial key→value table with expiration columns in SQLite, or a `Map` when
 * persistence across restarts is not wanted.
 *
 * @see spec/self-hosting.md §7.3
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  KVNamespace,
  KVNamespaceListOptions,
  KVNamespacePutOptions,
} from "@cloudflare/workers-types";

interface Entry {
  value: string;
  metadata: string | null;
  /** Absolute expiry in epoch seconds, or null for no expiry. */
  expiration: number | null;
}

/** Backing store the KV shim reads/writes; abstracts SQLite vs `Map`. */
interface Backing {
  get(key: string): Entry | undefined;
  set(key: string, entry: Entry): void;
  remove(key: string): void;
  keys(): string[];
}

class MemoryBacking implements Backing {
  readonly #map = new Map<string, Entry>();
  get(key: string): Entry | undefined {
    return this.#map.get(key);
  }
  set(key: string, entry: Entry): void {
    this.#map.set(key, entry);
  }
  remove(key: string): void {
    this.#map.delete(key);
  }
  keys(): string[] {
    return [...this.#map.keys()];
  }
}

class SqliteBacking implements Backing {
  readonly #get: StatementSync;
  readonly #set: StatementSync;
  readonly #del: StatementSync;
  readonly #all: StatementSync;

  constructor(location: string) {
    if (location !== ":memory:") {
      mkdirSync(dirname(location), { recursive: true });
    }
    const db = new DatabaseSync(location);
    db.exec(
      `CREATE TABLE IF NOT EXISTS kv (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         metadata TEXT,
         expiration INTEGER
       )`,
    );
    this.#get = db.prepare(
      "SELECT value, metadata, expiration FROM kv WHERE key = ?",
    );
    this.#set = db.prepare(
      `INSERT INTO kv (key, value, metadata, expiration) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           metadata = excluded.metadata,
           expiration = excluded.expiration`,
    );
    this.#del = db.prepare("DELETE FROM kv WHERE key = ?");
    this.#all = db.prepare("SELECT key FROM kv ORDER BY key");
  }

  get(key: string): Entry | undefined {
    const row = this.#get.get(key) as
      | { value: string; metadata: string | null; expiration: number | null }
      | undefined;
    return row ?? undefined;
  }
  set(key: string, entry: Entry): void {
    this.#set.run(key, entry.value, entry.metadata, entry.expiration);
  }
  remove(key: string): void {
    this.#del.run(key);
  }
  keys(): string[] {
    return (this.#all.all() as { key: string }[]).map((r) => r.key);
  }
}

class ShimKVNamespace {
  readonly #backing: Backing;
  readonly #now: () => number;

  constructor(backing: Backing, now: () => number) {
    this.#backing = backing;
    this.#now = now;
  }

  async get(key: string, type?: unknown): Promise<unknown> {
    const entry = this.#live(key);
    if (entry === null) return null;
    const kind =
      typeof type === "string" ? type : (type as { type?: string })?.type;
    if (kind === "json") return JSON.parse(entry.value);
    if (kind === "arrayBuffer")
      return new TextEncoder().encode(entry.value).buffer;
    return entry.value;
  }

  async getWithMetadata(key: string, type?: unknown): Promise<unknown> {
    const entry = this.#live(key);
    const value = await this.get(key, type);
    return {
      value,
      metadata: entry?.metadata ? JSON.parse(entry.metadata) : null,
      cacheStatus: null,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void> {
    const text =
      typeof value === "string"
        ? value
        : new TextDecoder().decode(await toBytes(value));
    let expiration: number | null = null;
    if (options?.expiration !== undefined) expiration = options.expiration;
    else if (options?.expirationTtl !== undefined) {
      expiration = Math.floor(this.#now() / 1000) + options.expirationTtl;
    }
    this.#backing.set(key, {
      value: text,
      metadata: options?.metadata ? JSON.stringify(options.metadata) : null,
      expiration,
    });
  }

  async delete(key: string): Promise<void> {
    this.#backing.remove(key);
  }

  async list(options?: KVNamespaceListOptions): Promise<unknown> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys = this.#backing
      .keys()
      .filter((k) => k.startsWith(prefix) && this.#live(k) !== null)
      .slice(0, limit)
      .map((name) => {
        const entry = this.#backing.get(name);
        return {
          name,
          expiration: entry?.expiration ?? undefined,
          metadata: entry?.metadata ? JSON.parse(entry.metadata) : undefined,
        };
      });
    return { keys, list_complete: true, cacheStatus: null };
  }

  /** Read an entry, lazily evicting it if expired. */
  #live(key: string): Entry | null {
    const entry = this.#backing.get(key);
    if (entry === undefined) return null;
    if (entry.expiration !== null && entry.expiration <= this.#now() / 1000) {
      this.#backing.remove(key);
      return null;
    }
    return entry;
  }
}

async function toBytes(
  value: ArrayBuffer | ArrayBufferView | ReadableStream,
): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

/** Options for {@link createKVNamespace}. */
export interface KVOptions {
  /** SQLite file to persist into; omit (or `":memory:"`) for an in-memory store. */
  readonly location?: string;
  /** Clock source, for deterministic expiry tests. */
  readonly now?: () => number;
}

/**
 * Create a {@link KVNamespace}. With a `location` it persists to SQLite; without
 * one it is an in-memory `Map` (cache that does not survive a restart).
 */
export function createKVNamespace(options: KVOptions = {}): KVNamespace {
  const backing: Backing =
    options.location && options.location !== ":memory:"
      ? new SqliteBacking(options.location)
      : new MemoryBacking();
  return new ShimKVNamespace(
    backing,
    options.now ?? Date.now,
  ) as unknown as KVNamespace;
}
