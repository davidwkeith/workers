/**
 * Permissive CORS for browser apps on other origins (draft §6). remoteStorage
 * is built for "no-backend" web apps that run on an origin different from the
 * storage server, so every response — including errors and the preflight — must
 * carry CORS headers or the browser hides the result from the app.
 *
 * Pure and runtime-free: it maps a request `Origin` to the header set. Bearer
 * tokens travel in the `Authorization` header (not cookies), so credentialed
 * CORS is unnecessary and `*` is a safe default; when a concrete `Origin` is
 * present it is echoed (with `Vary: Origin`) so caches stay correct.
 */

/** Methods the storage API exposes, advertised on the preflight. */
export const ALLOWED_METHODS = "GET, HEAD, PUT, DELETE, OPTIONS";

/** Request headers a browser app may send (preflight `Access-Control-Allow-Headers`). */
const ALLOWED_HEADERS =
  "Authorization, Content-Type, Content-Length, If-Match, If-None-Match, Origin, X-Requested-With";

/** Response headers a browser app may read (`Access-Control-Expose-Headers`). */
const EXPOSED_HEADERS = "ETag, Content-Type, Content-Length, Location";

/** How long (seconds) a browser may cache the preflight result. */
const MAX_AGE = "86400";

/** Build the CORS header set for a request with the given `Origin` (may be null). */
export function corsHeaders(
  requestOrigin: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-origin": requestOrigin ?? "*",
    "access-control-expose-headers": EXPOSED_HEADERS,
    vary: "Origin",
  };
  return headers;
}

/** The preflight (`OPTIONS`) response, answered at the edge without a store hit. */
export function preflightResponse(requestOrigin: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(requestOrigin),
      "access-control-allow-methods": ALLOWED_METHODS,
      "access-control-allow-headers": ALLOWED_HEADERS,
      "access-control-max-age": MAX_AGE,
    },
  });
}

/**
 * Return `response` with the CORS headers merged in. The body and status are
 * preserved; existing headers win only for names CORS does not own.
 */
export function withCors(
  response: Response,
  requestOrigin: string | null,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(requestOrigin))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
