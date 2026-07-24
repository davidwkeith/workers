/**
 * Small response helpers: JSON bodies and OAuth 2.0 error responses
 * (`{error, error_description}` with the right status), shared by the handlers.
 *
 * @packageDocumentation
 */

/** A JSON response with no-store caching (tokens/metadata must not be cached). */
export function json(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/** An RFC 6749 §5.2 token/authorization error body. */
export function oauthError(
  status: number,
  error: string,
  description?: string,
): Response {
  return json(status, {
    error,
    ...(description ? { error_description: description } : {}),
  });
}
