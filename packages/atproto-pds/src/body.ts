/**
 * `@dwk/atproto-pds` — a capped read for inbound request bodies (blob
 * uploads via `com.atproto.repo.uploadBlob`, migration CAR imports via
 * `com.atproto.repo.importRepo`).
 *
 * Both endpoints are authenticated but still let the caller choose the body
 * size, so without a cap the Durable Object would buffer the whole body
 * before ever checking it, risking the 128 MB isolate memory ceiling. A
 * declared `Content-Length` over the limit is rejected up front as a cheap
 * optimization, but the stream is always read incrementally and aborted
 * (`reader.cancel()`) the moment the running total exceeds the cap — so a
 * missing or understated `Content-Length` (e.g. chunked transfer-encoding)
 * cannot force the whole body into memory before the limit is enforced.
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

  const chunks: Uint8Array[] = [];
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

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
