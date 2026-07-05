/**
 * `@dwk/activitypub` — a capped read for inbound request bodies.
 *
 * `POST /inbox` is reachable by any federation peer with no authentication
 * prior to HTTP signature verification, and verifying that signature requires
 * the full body (the signature covers the content digest) — so the body must
 * be buffered before it can be rejected. Without a cap, an unauthenticated
 * peer controls how much memory the Worker allocates on every delivery
 * attempt, risking the 128 MB isolate limit. This mirrors the proven
 * capped-read pattern in `@dwk/webmention`'s `fetch.ts` / `@dwk/websub`'s
 * `fetch.ts`, applied to a `Request` instead of a `Response`. See
 * `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

/**
 * Default cap on an inbound request body (2 MB). Real-world AS2 activities
 * are KB-scale; this is generous headroom while still refusing to buffer an
 * unbounded body.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Read a request body as a `Uint8Array`, refusing bodies larger than
 * `maxBytes`.
 *
 * A declared `Content-Length` over the cap is rejected up front; the stream is
 * then read incrementally and aborted the moment the cap is exceeded, so a
 * missing or lying `Content-Length` cannot force the whole body into memory.
 * Returns `null` when the body is too large or cannot be read.
 */
export async function readRequestBodyCapped(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      return null;
    }
  }

  const body = request.body;
  if (body === null) {
    try {
      const buffer = await request.arrayBuffer();
      return buffer.byteLength > maxBytes ? null : new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
