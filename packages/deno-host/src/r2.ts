/**
 * `R2Bucket` → S3-compatible REST shim (host-contract §3.4, issue #400).
 *
 * Deno Deploy has no bundled object store, so this is a thin adapter over an
 * external S3-compatible provider (R2 itself, MinIO, Backblaze B2, Tigris,
 * DigitalOcean Spaces, ...): `put`/`get`/`head`/`delete` map directly onto
 * the S3 REST verbs `PUT`/`GET`/`HEAD`/`DELETE` on `{endpoint}/{key}`.
 * `httpMetadata.contentType` round-trips as the `Content-Type` header;
 * `customMetadata` round-trips as `x-amz-meta-*` headers, the universal
 * S3 custom-metadata convention.
 *
 * Like the other seams in this package, the shim never signs a request or
 * holds credentials itself — the composing app injects an {@link
 * S3ClientLike}, a `fetch`-shaped function already configured to sign
 * requests for the target endpoint (e.g. `aws4fetch`'s `AwsClient#fetch`
 * bound to the provider's endpoint/region/credentials). A real `AwsClient`
 * instance is assignable to {@link S3ClientLike} unmodified.
 *
 * `list`, multipart uploads, conditional operations (`onlyIf`), and range
 * reads are out of host-contract §3.4's required subset and are not
 * implemented — the GC design tracks orphans in a D1 table rather than
 * listing the bucket, so no production consumer needs `list` either.
 *
 * @see spec/packages/deno-host.md "Design: R2Bucket-shaped object storage
 * adapter (issue #400)"
 */

import type {
  R2Bucket,
  R2HTTPMetadata,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from "@cloudflare/workers-types";

/**
 * A `fetch`-shaped function already authenticated/signed for the target
 * S3-compatible endpoint. The shim never constructs a client or holds
 * credentials — the composing app supplies one (e.g. `aws4fetch`'s
 * `AwsClient#fetch`, bound via `.bind(client)`, or any equivalent signer).
 *
 * Streaming request bodies (a `put` given a `ReadableStream`) need the
 * caller's signer to support them without buffering the whole body to
 * compute a payload hash — verify this against the chosen provider/signer
 * before relying on it for large objects; `spec/packages/deno-host.md`
 * tracks it as a live-verification item, not something this shim can
 * guarantee on the caller's behalf.
 */
export interface S3ClientLike {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** `RequestInit` widened with the streaming-body option a `put` given a
 *  `ReadableStream` needs to set; not every `RequestInit` typing declares
 *  it, so this shim's own call sites use this type rather than relying on
 *  whichever global `RequestInit` happens to be in scope. */
type FetchInit = RequestInit & { duplex?: "half" };

export interface S3BucketOptions {
  readonly client: S3ClientLike;
  /**
   * Base URL up to and including the bucket, path-style, no trailing slash
   * (e.g. `https://<account>.r2.cloudflarestorage.com/<bucket>` or
   * `https://s3.<region>.amazonaws.com/<bucket>`). Object keys are appended
   * as `${endpoint}/${encodedKey}`.
   */
  readonly endpoint: string;
}

const CUSTOM_METADATA_PREFIX = "x-amz-meta-";

/** R2 `put` accepts these body shapes. */
type R2PutValue =
  ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;

function readContentType(
  http: R2PutOptions["httpMetadata"],
): string | undefined {
  if (http === undefined) return undefined;
  if (http instanceof Headers) return http.get("content-type") ?? undefined;
  return (http as R2HTTPMetadata).contentType;
}

/** Percent-encode each path segment, preserving `/` as the key's separator. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Strip surrounding quotes from an S3 `ETag` response header, if present. */
function unquoteEtag(etag: string | null): string {
  if (etag === null) return "";
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

/**
 * Wrap a source stream so bytes pass through unbuffered while a running
 * total is kept — `put` needs the final size for the returned `R2Object`,
 * but must not read a streamed body fully into memory to get it (the same
 * no-buffering rule `@dwk/cf-shims`' filesystem shim satisfies by hashing
 * while it writes).
 */
function countingStream(source: ReadableStream<Uint8Array>): {
  readonly stream: ReadableStream<Uint8Array>;
  size(): number;
} {
  let size = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, size: () => size };
}

/** Normalize a `put` value into a fetch body plus a way to learn its size. */
function toRequestBody(value: R2PutValue): {
  readonly body: BodyInit | null;
  readonly size: () => number;
  readonly duplex?: "half";
} {
  if (value === null) return { body: null, size: () => 0 };
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return { body: bytes, size: () => bytes.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { body: value, size: () => value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    return { body: value, size: () => value.byteLength };
  }
  if (value instanceof Blob) {
    return { body: value, size: () => value.size };
  }
  const counted = countingStream(value);
  return { body: counted.stream, size: counted.size, duplex: "half" };
}

/** Extract `customMetadata` from `x-amz-meta-*` response headers.
 *
 * **Known fidelity gap:** HTTP header names are case-insensitive, so S3
 * folds every metadata key to lowercase. Unlike Cloudflare R2 (which
 * preserves the exact casing passed to `put`), a key written as
 * `"traceId"` reads back as `"traceid"`. Harmless for every current
 * consumer (`@dwk/store` and friends look metadata keys up by a
 * fixed, already-lowercase name), documented rather than hidden.
 */
function readCustomMetadata(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.startsWith(CUSTOM_METADATA_PREFIX)) {
      out[name.slice(CUSTOM_METADATA_PREFIX.length)] = value;
    }
  });
  return out;
}

class S3Bucket {
  readonly #client: S3ClientLike;
  readonly #endpoint: string;

  constructor(options: S3BucketOptions) {
    this.#client = options.client;
    // Avoid an unanchored regex here (`/\/+$/` is worst-case O(n^2) on a
    // backtracking engine for a pathological all-slashes input) — a plain
    // loop strips the same trailing slashes in O(n).
    let endpoint = options.endpoint;
    while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
    this.#endpoint = endpoint;
  }

  #url(key: string): string {
    return `${this.#endpoint}/${encodeKey(key)}`;
  }

  async put(
    key: string,
    value: R2PutValue,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const contentType = readContentType(options?.httpMetadata);
    const customMetadata = options?.customMetadata ?? {};
    const headers = new Headers();
    if (contentType) headers.set("content-type", contentType);
    for (const [name, metaValue] of Object.entries(customMetadata)) {
      headers.set(`${CUSTOM_METADATA_PREFIX}${name}`, metaValue);
    }

    const { body, size, duplex } = toRequestBody(value);
    const init: FetchInit = { method: "PUT", headers, body };
    if (duplex) init.duplex = duplex;
    const res = await this.#client.fetch(this.#url(key), init);
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) {
      throw new Error(`R2 put failed for "${key}": ${res.status}`);
    }

    return this.#objectMeta(key, {
      size: size(),
      etag: unquoteEtag(res.headers.get("etag")),
      uploaded: new Date(),
      contentType,
      customMetadata,
    });
  }

  async head(key: string): Promise<R2Object | null> {
    const res = await this.#client.fetch(this.#url(key), { method: "HEAD" });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 head failed for "${key}": ${res.status}`);
    return this.#objectFromResponse(key, res);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const res = await this.#client.fetch(this.#url(key), { method: "GET" });
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`R2 get failed for "${key}": ${res.status}`);
    }
    return this.#objectBodyFromResponse(key, res);
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      const res = await this.#client.fetch(this.#url(key), {
        method: "DELETE",
      });
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 delete failed for "${key}": ${res.status}`);
      }
    }
  }

  #objectFromResponse(key: string, res: Response): R2Object {
    const contentType = res.headers.get("content-type") ?? undefined;
    const lastModified = res.headers.get("last-modified");
    return this.#objectMeta(key, {
      size: Number(res.headers.get("content-length") ?? 0),
      etag: unquoteEtag(res.headers.get("etag")),
      uploaded: lastModified !== null ? new Date(lastModified) : new Date(0),
      contentType,
      customMetadata: readCustomMetadata(res.headers),
    });
  }

  #objectBodyFromResponse(key: string, res: Response): R2ObjectBody {
    const base = this.#objectFromResponse(key, res);
    const body = {
      ...base,
      bodyUsed: false,
      body: res.body,
      arrayBuffer: (): Promise<ArrayBuffer> => res.arrayBuffer(),
      text: (): Promise<string> => res.text(),
      json: <T>(): Promise<T> => res.json() as Promise<T>,
      blob: (): Promise<Blob> => res.blob(),
      bytes: async (): Promise<Uint8Array> =>
        new Uint8Array(await res.arrayBuffer()),
    };
    return body as unknown as R2ObjectBody;
  }

  #objectMeta(
    key: string,
    meta: {
      size: number;
      etag: string;
      uploaded: Date;
      contentType?: string;
      customMetadata: Record<string, string>;
    },
  ): R2Object {
    return {
      key,
      size: meta.size,
      etag: meta.etag,
      httpEtag: `"${meta.etag}"`,
      version: meta.etag,
      uploaded: meta.uploaded,
      httpMetadata: meta.contentType ? { contentType: meta.contentType } : {},
      customMetadata: meta.customMetadata,
      checksums: { toJSON: () => ({}) },
      storageClass: "Standard",
      writeHttpMetadata(headers: Headers): void {
        if (meta.contentType) headers.set("content-type", meta.contentType);
      },
    } as unknown as R2Object;
  }
}

/**
 * Create an {@link R2Bucket} backed by an injected {@link S3ClientLike}
 * (a signed-fetch function) and the S3-compatible endpoint's base URL.
 * `list`, multipart uploads, conditional operations (`onlyIf`), and range
 * reads are not implemented — host-contract §3.4 doesn't require them, and
 * no `@dwk` package calls them.
 */
export function createS3Bucket(options: S3BucketOptions): R2Bucket {
  return new S3Bucket(options) as unknown as R2Bucket;
}
