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
 * always read incrementally into a **resizable `ArrayBuffer`** capped at
 * `maxBytes` (see `readRequestBodyCapped` below for the mechanism),
 * aborting (`reader.cancel()`) the moment a chunk would grow it past that
 * ceiling — so a missing or understated `Content-Length` (e.g. chunked
 * transfer-encoding) cannot grow the buffer past `maxBytes` regardless of
 * what it claims. Memory use tracks the bytes actually received, not the
 * configured cap: a 10-byte body against a 2 MiB cap costs ~10 bytes, not 2
 * MiB. `maxBytes` is a hard ceiling that can never be exceeded, not a fixed
 * safe size to allocate up front — a cap set close to (or at) the isolate
 * ceiling is still an OOM risk for a body that actually reaches it; see the
 * `maxBytes` callers for what they pass.
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
 * touching the body. Otherwise the body is read incrementally into a
 * resizable `ArrayBuffer` (`maxByteLength: maxBytes`) via a length-tracking
 * `Uint8Array` view: each chunk grows the backing buffer by exactly its own
 * size (`ArrayBuffer.prototype.resize`) right before being written in, so
 * memory committed tracks the bytes actually received rather than the
 * configured cap. `resize()` is only ever asked to grow to `offset +
 * value.byteLength`, checked against `maxBytes` (and the reader cancelled)
 * *before* the resize, so the buffer can never be grown past the cap
 * regardless of what `Content-Length` claims or omits. There is no separate
 * chunk array and no second "merge" allocation — the length-tracking view
 * already has exactly the right length when the loop ends, so it's returned
 * directly.
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

  // A resizable ArrayBuffer reserves address space up to `maxBytes` but only
  // commits memory as `resize()` grows it — so memory use tracks the bytes
  // actually received, not the configured cap, while `maxBytes` is still a
  // hard ceiling `resize()` can never be asked to exceed. `view` is a
  // length-tracking Uint8Array (no explicit length argument), so it
  // automatically reflects `backing`'s current size after each resize: no
  // separate `chunks` array, no second "merged" allocation, and no trailing
  // `subarray` trim — `view` already IS exactly the right size once the loop
  // ends. This avoids both round-1's problem (accumulate-then-copy briefly
  // held ~2x the actual body size) and round-2's problem (pre-allocating the
  // full cap up front cost ~1x the cap on every call, regardless of how
  // little data actually arrived).
  const backing = new ArrayBuffer(0, { maxByteLength: maxBytes });
  const view = new Uint8Array(backing);
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
      backing.resize(offset + value.byteLength);
      view.set(value, offset);
      offset += value.byteLength;
    }
  }
  return view;
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
