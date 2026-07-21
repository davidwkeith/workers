/**
 * Small request/response helpers shared by the four endpoint handlers. Web
 * Fetch types only (`Request`/`Response`/`URLSearchParams`) so the handlers run
 * and test under plain Node.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Serialize `body` as a JSON response with the given status. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

/** A `405 Method Not Allowed` carrying the permitted methods in `Allow`. */
export function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow },
  });
}

/**
 * Read an `application/x-www-form-urlencoded` body into `URLSearchParams`. A
 * malformed/empty body or wrong content-type yields empty params (never throws),
 * so the caller's own field validation reports the problem as a `400` rather
 * than the handler crashing.
 *
 * Returns `null` when a parameter appears more than once. RFC 6749 §3.2 forbids
 * duplicate request parameters, and silently keeping the last (or first)
 * occurrence lets a request diverge from what a separately-parsing
 * authenticator sees (e.g. two `client_id`s, authenticated as A but recorded as
 * B). The caller MUST reject a `null` result with `invalid_request`.
 */
export async function readForm(
  request: Request,
): Promise<URLSearchParams | null> {
  const params = new URLSearchParams();
  const seen = new Set<string>();
  try {
    const form = await request.formData();
    for (const [key, value] of form) {
      if (typeof value !== "string") continue;
      if (seen.has(key)) return null;
      seen.add(key);
      params.set(key, value);
    }
  } catch {
    // Malformed/empty body → empty params; the caller's field validation 400s.
  }
  return params;
}

/**
 * Cap on a JSON request body under {@link readJson}, in bytes. Bounds memory
 * use against an oversized submission — most pointedly dynamic client
 * registration (RFC 7591), which by design accepts requests from anyone under
 * open registration and would otherwise buffer an arbitrarily large body in
 * full before validation ever runs.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Parse a JSON request body, returning `undefined` if it is absent, malformed,
 * or exceeds {@link MAX_JSON_BODY_BYTES}. Reads the body incrementally so an
 * oversized submission is abandoned without buffering it in full.
 */
export async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) {
    try {
      return (await request.json()) as unknown;
    } catch {
      return undefined;
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  try {
    const text = new TextDecoder().decode(concatBytes(chunks, total));
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Build the `WWW-Authenticate` challenge for a `401` client-authentication
 * failure, matching the scheme the request actually attempted rather than
 * unconditionally asserting `Bearer`. A `client_secret_basic` client sends
 * `Authorization: Basic ...`, so a `Bearer` challenge back is simply wrong —
 * that scheme is not how the client authenticates, and a compliant HTTP
 * client keys its retry behavior off this header. Defaults to `Bearer` when
 * the request carried no recognized `Authorization` scheme (also correct for
 * `client_secret_post`/`none` clients and a bearer-token-authenticated
 * endpoint that received no header at all).
 */
export function wwwAuthenticateChallenge(request: Request): string {
  const scheme = request.headers.get("authorization")?.split(" ")[0];
  return scheme && /^basic$/i.test(scheme) ? 'Basic realm="oauth"' : "Bearer";
}
