/**
 * `@dwk/safe-fetch` — capped response body readers.
 *
 * Reading an attacker- or user-supplied URL's response body without a cap
 * risks buffering an unbounded payload against a Worker's 128 MB isolate
 * memory limit. These readers refuse a declared `Content-Length` over the
 * cap up front, then read the stream incrementally and abort the moment the
 * cap is exceeded — so a missing or lying `Content-Length` cannot force the
 * whole body into memory. See `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

/** Default cap on a fetched body (2 MB) when no explicit cap is given. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readChunks(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
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
      const buffer = await response.arrayBuffer();
      return buffer.byteLength > maxBytes ? null : new Uint8Array(buffer);
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
  return merged;
}

/**
 * Read a response body as text, refusing bodies larger than `maxBytes`.
 * Returns `null` when the body is too large or cannot be read.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string | null> {
  const bytes = await readChunks(response, maxBytes);
  if (bytes === null) {
    return null;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read a response body as a `Uint8Array`, refusing bodies larger than
 * `maxBytes`. Returns `null` when the body is too large or cannot be read.
 */
export async function readBytesCapped(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array | null> {
  return readChunks(response, maxBytes);
}
