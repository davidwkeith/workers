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
 * always read incrementally and written directly into a single buffer
 * pre-allocated to `maxBytes`, aborting (`reader.cancel()`) the moment a
 * chunk would overflow it — so a missing or understated `Content-Length`
 * (e.g. chunked transfer-encoding) cannot force an allocation bigger than
 * `maxBytes` regardless of what it claims. This bounds memory to the
 * caller's configured cap, not to some fixed safe size — a cap set close to
 * (or at) the isolate ceiling is still an OOM risk in its own right; see the
 * `maxBytes` callers for what they pass. Note the pre-allocated buffer costs
 * `maxBytes` bytes momentarily on *every* call regardless of how much data
 * actually arrives (a 10-byte body against a 2 MiB cap still allocates 2 MiB
 * up front) — that's the deliberate trade this makes for a genuine, provable
 * single-allocation bound instead of accumulating chunks and copying them
 * into a second buffer sized to the real total (which would briefly hold
 * both the chunks and the copy at once).
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
 * touching the body. Otherwise a single buffer sized to `maxBytes` is
 * allocated once, up front, and each chunk is written directly into it as it
 * arrives — the reader is cancelled the instant a chunk would overflow the
 * buffer, so nothing is ever allocated or copied past the cap regardless of
 * what `Content-Length` claims or omits. There is no intermediate
 * chunk-array-then-copy step: peak memory is the single `maxBytes`
 * allocation, not that plus a second buffer sized to the actual total. The
 * returned array is a zero-copy `subarray` view over the pre-allocated
 * buffer, trimmed to the bytes actually received.
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

  // Allocate the one buffer this read will ever need, sized to the cap,
  // *before* reading anything. Each chunk is written straight into it as it
  // arrives (checking the cap before the write, so a chunk can never be
  // written past the buffer's end), and there is no separate `chunks` array
  // to hold onto: at no point does this function reference both a
  // fully-populated buffer and the raw chunks that filled it, which is what
  // an "accumulate chunks, then copy them into a merged buffer" approach
  // would do (that shape briefly holds ~2x the data — the chunks plus the
  // copy — no matter when the chunk references are dropped, since the copy
  // target is allocated in full before any copying/releasing starts).
  const merged = new Uint8Array(maxBytes);
  let offset = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      if (offset + value.byteLength > maxBytes) {
        await reader.cancel();
        throw namedError(400, errorName, message);
      }
      merged.set(value, offset);
      offset += value.byteLength;
    }
  }
  // A zero-copy view over the bytes actually received — trimming via
  // `subarray` (not `slice`) costs nothing extra.
  return merged.subarray(0, offset);
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
