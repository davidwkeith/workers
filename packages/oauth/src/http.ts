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

/** Parse a JSON request body, returning `undefined` if it is absent/malformed. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}
