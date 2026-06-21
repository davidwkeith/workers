/**
 * The per-account Durable Object: the single-threaded consistency authority for
 * one remoteStorage vault.
 *
 * The stateless front door (`handler.ts`) authenticates the bearer token and
 * enforces per-module scopes at the edge, then forwards already-authorized
 * requests here, where Cloudflare guarantees one thread per account. Everything
 * that must be strongly consistent — document GET/PUT/DELETE, conditional
 * (`If-Match`/`If-None-Match`) writes, document↔folder conflict detection, the
 * virtual folder listing and its aggregate ETag, and R2 copy-on-write through
 * `@dwk/store` — happens here. This object reuses `@dwk/store` exactly as
 * `@dwk/solid-pod` does (same library, same storage primitives); the only Solid
 * facility it leans on beyond the blob tier is the generic `list(prefix)`
 * projection. Consumers bind this class as a Durable Object namespace.
 */

import { DurableObject } from "cloudflare:workers";

import {
  createStore,
  d1OrphanSink,
  forwardOrphans,
  PreconditionFailedError,
  type Store,
  type WriteOptions,
} from "@dwk/store";

import { INTERNAL_HEADERS, type RemoteStorageEnv } from "./config.js";
import {
  buildFolderModel,
  FOLDER_DESCRIPTION_TYPE,
  hashSignature,
  renderFolderDescription,
} from "./folder.js";
import { isFolderPath } from "./scope.js";

/** Config the front door forwards to the DO (everything else is per-request). */
interface ForwardedConfig {
  readonly maxInlineBytes?: number;
}

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

export class RemoteStorageObject extends DurableObject<RemoteStorageEnv> {
  #store: Store | null = null;

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

  override async fetch(request: Request): Promise<Response> {
    const config: ForwardedConfig = (() => {
      const raw = request.headers.get(INTERNAL_HEADERS.config);
      if (!raw) return {};
      try {
        return JSON.parse(raw) as ForwardedConfig;
      } catch {
        return {};
      }
    })();

    const store = this.#getStore(config);
    const url = new URL(request.url);
    // Keep the path percent-encoded: decoding `%2F` would conflate it with a
    // real separator and corrupt store keys.
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      switch (method) {
        case "HEAD":
        case "GET":
          return isFolderPath(path)
            ? await this.#readFolder(store, path, request, method === "HEAD")
            : await this.#readDocument(store, path, request, method === "HEAD");
        case "PUT":
          return await this.#putDocument(store, path, request);
        case "DELETE":
          return await this.#deleteDocument(store, path, request);
        default:
          return text(405, "Method Not Allowed", { allow: ALLOW });
      }
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        return text(412, "Precondition Failed");
      }
      if (error instanceof LengthRequiredError) {
        return text(411, "Length Required");
      }
      throw error;
    }
  }

  // -- document read ---------------------------------------------------------

  async #readDocument(
    store: Store,
    path: string,
    request: Request,
    headOnly: boolean,
  ): Promise<Response> {
    const meta = store.head(path);
    if (!meta) return text(404, "Not Found");

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatchSatisfied(ifNoneMatch, meta.etag)) {
      return new Response(null, {
        status: 304,
        headers: { etag: meta.etag, "cache-control": "no-cache" },
      });
    }

    const blob = await store.readBlob(path);
    // A non-blob pointer at a document path should not arise (writes always go
    // through the blob tier), but guard rather than stream a null body.
    if (!blob) return text(404, "Not Found");

    const headers = documentHeaders(meta.etag, blob.contentType);
    headers.set("content-length", String(blob.size));
    if (headOnly) {
      await blob.stream.cancel();
      return new Response(null, { status: 200, headers });
    }
    return new Response(blob.stream, { status: 200, headers });
  }

  // -- folder read -----------------------------------------------------------

  async #readFolder(
    store: Store,
    path: string,
    request: Request,
    headOnly: boolean,
  ): Promise<Response> {
    // A folder is virtual: its listing and ETag derive from descendants. An
    // empty/absent folder still answers 200 with a stable ETag (over the empty
    // signature), matching remoteStorage's "folders always exist" model.
    const model = buildFolderModel(path, store.list(path));
    const etag = await hashSignature(model.signature);

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatchSatisfied(ifNoneMatch, etag)) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "no-cache" },
      });
    }

    const headers = new Headers({
      etag,
      "content-type": FOLDER_DESCRIPTION_TYPE,
      "cache-control": "no-cache",
      allow: ALLOW,
    });
    if (headOnly) return new Response(null, { status: 200, headers });

    const body = JSON.stringify(await renderFolderDescription(model));
    headers.set(
      "content-length",
      String(new TextEncoder().encode(body).length),
    );
    return new Response(body, { status: 200, headers });
  }

  // -- document write --------------------------------------------------------

  async #putDocument(
    store: Store,
    path: string,
    request: Request,
  ): Promise<Response> {
    if (isFolderPath(path)) {
      // A folder path (trailing slash) is not a document; remoteStorage has no
      // verb to create a folder directly (draft §6).
      return text(400, "Cannot PUT a folder", { allow: ALLOW });
    }
    // Document↔folder name collisions are forbidden (draft §6): a path that
    // already has descendants is a folder, and any ancestor that is a document
    // would shadow this one.
    const conflict = this.#conflict(store, path);
    if (conflict) return text(409, conflict, { allow: ALLOW });

    const existed = store.head(path) !== null;
    await this.#writeBody(store, path, request, {
      ifMatch: ifMatchOf(request),
      ifNoneMatch: ifNoneMatchOf(request),
    });
    await this.#drainOrphans(store);

    const meta = store.head(path);
    const headers = new Headers({ allow: ALLOW });
    if (meta) headers.set("etag", meta.etag);
    return new Response(null, { status: existed ? 200 : 201, headers });
  }

  // -- document delete -------------------------------------------------------

  async #deleteDocument(
    store: Store,
    path: string,
    request: Request,
  ): Promise<Response> {
    if (isFolderPath(path)) {
      return text(400, "Cannot DELETE a folder", { allow: ALLOW });
    }
    const meta = store.head(path);
    if (!meta) return text(404, "Not Found");

    const oldEtag = meta.etag;
    store.delete(path, { ifMatch: ifMatchOf(request) });
    await this.#drainOrphans(store);

    // The emptied parent folders simply vanish — they are virtual. The deleted
    // document's ETag is returned for clients that track it (draft §6).
    return new Response(null, {
      status: 200,
      headers: { etag: oldEtag, allow: ALLOW },
    });
  }

  // -- helpers ---------------------------------------------------------------

  /**
   * Detect a document↔folder name collision for a PUT to `path`. Returns a
   * human-readable reason, or `null` when the write is unobstructed:
   *  - `path` already has descendants ⇒ it is a folder, not a document;
   *  - an ancestor segment is itself a stored document ⇒ it would shadow `path`.
   */
  #conflict(store: Store, path: string): string | null {
    if (store.list(`${path}/`).length > 0) {
      return "A folder already exists at this path";
    }
    let slash = path.indexOf("/", 1);
    while (slash !== -1) {
      const ancestor = path.slice(0, slash);
      if (ancestor.length > 0 && store.head(ancestor) !== null) {
        return "A document already exists at an ancestor path";
      }
      slash = path.indexOf("/", slash + 1);
    }
    return null;
  }

  /**
   * Forward any blob keys the store outboxed (copy-on-write displacements and
   * deletes) into the shared D1 GC table, so the out-of-band cron can reclaim
   * them without waking this DO. No-op when `GC_DB` is not bound.
   */
  async #drainOrphans(store: Store): Promise<void> {
    if (!this.env.GC_DB) return;
    await forwardOrphans(store, d1OrphanSink(this.env.GC_DB));
  }

  /**
   * Write a request body as a document blob without ever buffering an oversized
   * body in the DO. A body known (by `Content-Length`) to exceed the offload
   * ceiling is streamed straight to R2; a small or undeclared body is probed up
   * to the ceiling (trusting nothing) and written from memory, while a probe
   * that overflows an undeclared length is rejected `411` rather than buffered.
   */
  async #writeBody(
    store: Store,
    path: string,
    request: Request,
    preconditions: Pick<WriteOptions, "ifMatch" | "ifNoneMatch">,
  ): Promise<void> {
    const contentType =
      request.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream";
    const declared = parseContentLength(request.headers.get("content-length"));

    if (declared !== null && declared > store.maxInlineBytes) {
      await store.putBlob(path, request.body ?? new Blob([]), {
        contentType,
        ...preconditions,
      });
      return;
    }

    const peeked = await readUpToLimit(request.body, store.maxInlineBytes);
    if (peeked.kind === "overflow") throw new LengthRequiredError();
    await store.putBlob(path, peeked.bytes, { contentType, ...preconditions });
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const ALLOW = "GET, HEAD, PUT, DELETE, OPTIONS";

/** Headers common to document responses. */
function documentHeaders(etag: string, contentType: string): Headers {
  return new Headers({
    etag,
    "content-type": contentType || "application/octet-stream",
    "cache-control": "no-cache",
    allow: ALLOW,
  });
}

/**
 * Whether a stored `etag` satisfies an `If-None-Match` header (RFC 7232 §3.2).
 * `*` matches any current representation; otherwise the comma-separated entity
 * tags are compared with the weak comparison function (the `W/` prefix ignored).
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

function ifMatchOf(request: Request): string | undefined {
  return request.headers.get("if-match") ?? undefined;
}

function ifNoneMatchOf(request: Request): string | undefined {
  return request.headers.get("if-none-match") ?? undefined;
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
 * absent or malformed (treated as "length unknown").
 */
function parseContentLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header)) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read at most `limit` bytes from `body` to classify an undeclared-length body
 * without buffering an oversized one. Returns the buffered bytes when the body
 * ends within `limit`; signals `overflow` (cancelling the body) the moment it
 * exceeds `limit`. A body of exactly `limit` bytes still fits.
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

/** Thrown by `#writeBody` when an unsized body is too large to buffer or stream (→ 411). */
class LengthRequiredError extends Error {}
