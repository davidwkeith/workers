/**
 * `@dwk/atproto-pds` — a capped read for inbound request bodies: blob
 * uploads (`com.atproto.repo.uploadBlob`), migration CAR imports
 * (`com.atproto.repo.importRepo`), and small JSON control payloads
 * (`createSession`, `updateHandle`, `createRecord`, `putRecord`,
 * `deleteRecord`).
 *
 * All of these let the caller choose the body size, so without a cap the
 * Durable Object would buffer the whole body before ever checking it,
 * risking the 128 MB isolate memory ceiling. `createSession` in particular
 * is reachable with **no authentication at all** — it's the login endpoint —
 * so its cap can't lean on an auth check running first the way the other
 * four (all behind `#requireAuth`) can. A declared `Content-Length` over the
 * limit is rejected up front as a cheap optimization, but the stream is
 * always read incrementally and aborted (`reader.cancel()`) the moment the
 * running total exceeds the cap — so a missing or understated
 * `Content-Length` (e.g. chunked transfer-encoding) cannot force a buffer
 * bigger than `maxBytes` regardless of what it claims. This bounds memory to
 * the caller's configured cap, not to some fixed safe size — a cap set close
 * to (or at) the isolate ceiling is still an OOM risk in its own right; see
 * the `maxBytes` callers for what they pass.
 *
 * This mirrors the capped-read pattern in `@dwk/activitypub`'s
 * `readRequestBodyCapped` (also copied into `@dwk/solid-oidc`'s `body.ts`),
 * adapted to this package's `namedError` XRPC error convention (throwing a
 * named XRPC error) instead of their `null`-on-reject convention. It is kept
 * as a local, dependency-free copy rather than an import from either package:
 * `@dwk/atproto-pds` is a self-contained package that shares neither
 * `@dwk/store` nor `@dwk/rdf` with the rest of the monorepo and is meant to
 * stay dependency-minimal (see the package's `CLAUDE.md`).
 *
 * @packageDocumentation
 */

import { namedError } from "./xrpc.js";

/**
 * Read a request body as a `Uint8Array`, throwing `namedError(400, errorName,
 * message)` if it exceeds `maxBytes`.
 *
 * A declared `Content-Length` over the cap is rejected up front without
 * touching the body. Otherwise the stream is read incrementally and the
 * reader is cancelled the instant the running total exceeds `maxBytes`, so
 * the buffer this function builds never grows past the cap regardless of
 * what `Content-Length` claims — or omits.
 */
export async function readRequestBodyCapped(
  request: Request,
  maxBytes: number,
  errorName: string,
  message: string,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw namedError(400, errorName, message);
    }
  }

  const body = request.body;
  if (body === null) {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw namedError(400, errorName, message);
    }
    return new Uint8Array(buffer);
  }

  const chunks: (Uint8Array | undefined)[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw namedError(400, errorName, message);
      }
      chunks.push(value);
    }
  }

  // Copy each chunk into `merged` and drop this function's own reference to
  // it immediately after, so the copied chunk becomes collectible before the
  // next one is read/copied. Without this, `chunks` stays live for the whole
  // loop and peak memory is ~2x the body size (the still-referenced chunks
  // plus the `merged` copy) instead of the ~1x a capped read should cost.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    merged.set(chunk, offset);
    offset += chunk.byteLength;
    chunks[i] = undefined;
  }
  return merged;
}

/**
 * Read a request body as JSON, throwing `namedError(400, errorName, message)`
 * if the (undecoded) byte size exceeds `maxBytes` — via
 * {@link readRequestBodyCapped}, so the size cap is enforced the same
 * incremental, `Content-Length`-independent way as the blob/CAR reads above.
 *
 * A malformed body that fails `JSON.parse` is **not** caught here: it throws
 * the same native `SyntaxError` `request.json()` always has, which the XRPC
 * error boundary (`xrpc.ts`'s `errorResponse`) already turns into a generic
 * `InternalServerError` 500 — unchanged from every call site's behavior
 * before this helper existed. Only the size-cap behavior is new.
 */
export async function readJsonBodyCapped<T>(
  request: Request,
  maxBytes: number,
  errorName: string,
  message: string,
): Promise<T> {
  const bytes = await readRequestBodyCapped(
    request,
    maxBytes,
    errorName,
    message,
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
