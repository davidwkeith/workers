/**
 * `@dwk/webmention` — injectable `fetch` type.
 *
 * Endpoint discovery, source verification, and sending all perform HTTP I/O.
 * They accept a {@link FetchLike} so callers can inject a stub in tests (no
 * network) and so the package never reaches for a global it didn't receive.
 *
 * @packageDocumentation
 */

/** A minimal, injectable `fetch` signature. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Default cap on a fetched document body (2 MB). Discovery and verification
 * only need to scan markup for links; a larger body is almost certainly hostile
 * or irrelevant, and buffering it would risk an OOM (the Worker memory limit is
 * 128 MB). See `spec/non-functional-requirements.md`.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Read a response body as text, refusing bodies larger than `maxBytes`.
 *
 * A declared `Content-Length` over the cap is rejected up front; the stream is
 * then read incrementally and aborted the moment the cap is exceeded, so a
 * missing or lying `Content-Length` cannot force the whole body into memory.
 * Returns `null` when the body is too large or cannot be read.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes = MAX_BODY_BYTES,
): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      return null;
    }
  }

  const body = response.body;
  if (body === null) {
    try {
      const text = await response.text();
      return text.length > maxBytes ? null : text;
    } catch {
      return null;
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
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
  return new TextDecoder().decode(merged);
}
