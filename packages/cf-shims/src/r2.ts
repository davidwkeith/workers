/**
 * `R2Bucket` → filesystem shim.
 *
 * Each object is stored as a file under the data directory, keyed by its R2 key
 * (content-addressed `sha256-…` keys from `@dwk/store` become nested file
 * names), with a JSON sidecar for HTTP metadata (content-type, custom metadata),
 * a computed MD5 ETag, an opaque `version`, and the upload time. **Bodies stream
 * to and from disk** — `put` consumes the `ReadableStream` to a file without
 * buffering, and `get` returns a file read stream as a `ReadableStream` —
 * preserving the no-buffering rule. `list` walks the directory tree applying
 * prefix/delimiter semantics.
 *
 * @see spec/self-hosting.md §7.2
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
  R2ListOptions,
  R2HTTPMetadata,
} from "@cloudflare/workers-types";

/** Persisted sidecar metadata for one stored object. */
interface ObjectMeta {
  readonly size: number;
  readonly etag: string;
  readonly version: string;
  readonly uploaded: string;
  readonly contentType?: string;
  readonly customMetadata?: Record<string, string>;
}

const META_SUFFIX = ".r2meta";

/** R2 `put` accepts these body shapes. */
type R2PutValue =
  ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;

class FsR2Bucket {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async head(key: string): Promise<R2Object | null> {
    const meta = await this.#readMeta(key);
    return meta === null ? null : this.#object(key, meta, false);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const meta = await this.#readMeta(key);
    if (meta === null) return null;
    return this.#object(key, meta, true) as R2ObjectBody;
  }

  async put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const path = this.#keyToPath(key);
    await mkdir(dirname(path), { recursive: true });

    const tmp = `${path}.${randomUUID()}.tmp`;
    const hash = createHash("md5");
    let size = 0;
    try {
      // `pipeline` handles backpressure and destroys both streams on error
      // (e.g. a full disk), so a write failure can't hang awaiting `drain`.
      await pipeline(
        toNodeStream(value),
        async function* (source): AsyncGenerator<Buffer> {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buf);
            size += buf.length;
            yield buf;
          }
        },
        createWriteStream(tmp),
      );
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }

    const meta: ObjectMeta = {
      size,
      etag: hash.digest("hex"),
      version: randomUUID(),
      uploaded: new Date().toISOString(),
      contentType: options?.httpMetadata
        ? readContentType(options.httpMetadata)
        : undefined,
      customMetadata: options?.customMetadata,
    };
    await rename(tmp, path);
    await writeFile(`${path}${META_SUFFIX}`, JSON.stringify(meta));
    return this.#object(key, meta, false);
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const path = this.#keyToPath(key);
      await rm(path, { force: true });
      await rm(`${path}${META_SUFFIX}`, { force: true });
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const delimiter = options?.delimiter ?? undefined;
    const limit = options?.limit ?? Infinity;

    const keys = (await this.#walk(this.#root))
      .filter((k) => k.startsWith(prefix))
      .sort();

    const objects: R2Object[] = [];
    const delimitedPrefixes = new Set<string>();
    for (const key of keys) {
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          delimitedPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      if (objects.length >= limit) break;
      const meta = await this.#readMeta(key);
      if (meta !== null) objects.push(this.#object(key, meta, false));
    }

    return {
      objects,
      truncated: false,
      delimitedPrefixes: [...delimitedPrefixes],
    } as unknown as R2Objects;
  }

  #keyToPath(key: string): string {
    const path = resolve(this.#root, key);
    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new Error(`R2 key escapes the bucket root: ${key}`);
    }
    return path;
  }

  async #readMeta(key: string): Promise<ObjectMeta | null> {
    try {
      const raw = await readFile(
        `${this.#keyToPath(key)}${META_SUFFIX}`,
        "utf8",
      );
      return JSON.parse(raw) as ObjectMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Recursively collect object keys under `dir` (excluding sidecars). */
  async #walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.#walk(full)));
      } else if (!entry.name.endsWith(META_SUFFIX)) {
        out.push(relative(this.#root, full).split(sep).join("/"));
      }
    }
    return out;
  }

  #object(key: string, meta: ObjectMeta, withBody: boolean): R2Object {
    const path = this.#keyToPath(key);
    const base = {
      key,
      size: meta.size,
      etag: meta.etag,
      httpEtag: `"${meta.etag}"`,
      version: meta.version,
      uploaded: new Date(meta.uploaded),
      httpMetadata: meta.contentType ? { contentType: meta.contentType } : {},
      customMetadata: meta.customMetadata ?? {},
      checksums: { toJSON: () => ({}) },
      writeHttpMetadata(headers: Headers): void {
        if (meta.contentType) headers.set("content-type", meta.contentType);
      },
      storageClass: "Standard",
    };
    if (!withBody) return base as unknown as R2Object;

    const body = {
      ...base,
      bodyUsed: false,
      get body(): ReadableStream {
        return Readable.toWeb(
          createReadStream(path),
        ) as unknown as ReadableStream;
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = await readFile(path);
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer;
      },
      async bytes(): Promise<Uint8Array> {
        return new Uint8Array(await readFile(path));
      },
      async text(): Promise<string> {
        return readFile(path, "utf8");
      },
      async json<T>(): Promise<T> {
        return JSON.parse(await readFile(path, "utf8")) as T;
      },
      async blob(): Promise<Blob> {
        return new Blob([await readFile(path)]);
      },
    };
    return body as unknown as R2Object;
  }
}

function readContentType(
  http: R2PutOptions["httpMetadata"],
): string | undefined {
  if (http === undefined) return undefined;
  if (http instanceof Headers) return http.get("content-type") ?? undefined;
  return (http as R2HTTPMetadata).contentType;
}

/** Normalise any R2 put value into an async-iterable byte stream. */
function toNodeStream(value: R2PutValue): Readable {
  if (value === null) return Readable.from([]);
  if (typeof value === "string") return Readable.from([Buffer.from(value)]);
  if (value instanceof ArrayBuffer) {
    return Readable.from([Buffer.from(new Uint8Array(value))]);
  }
  if (ArrayBuffer.isView(value)) {
    return Readable.from([
      Buffer.from(value.buffer, value.byteOffset, value.byteLength),
    ]);
  }
  if (value instanceof Blob) {
    return Readable.fromWeb(
      value.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
  }
  // Web ReadableStream
  return Readable.fromWeb(
    value as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
}

/**
 * Create an {@link R2Bucket} backed by a filesystem directory. Objects live
 * under `root`; the directory tree is created lazily on first `put`.
 */
export function createR2Bucket(root: string): R2Bucket {
  return new FsR2Bucket(root) as unknown as R2Bucket;
}
