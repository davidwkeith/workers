/**
 * `@dwk/solid-oidc` — a capped read for the token endpoint's request body.
 *
 * `POST /token` is public and unauthenticated prior to PKCE/code/DPoP
 * validation, and that validation needs the parsed form body — so the body
 * must be buffered before it can be rejected. Without a cap, an unauthenticated
 * caller controls how much memory the Worker allocates on every request,
 * risking the 128 MB isolate limit. Mirrors `@dwk/activitypub`'s
 * `readRequestBodyCapped` (same problem: a `Request`-flavored capped read,
 * which `@dwk/safe-fetch`'s `readBodyCapped` doesn't cover since that one
 * takes a `Response`). See `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

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
  maxBytes: number,
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
