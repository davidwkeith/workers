/** Mastodon-style JSON error responses: `{"error": "..."}` with a status. */

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Serialize a Mastodon error body. */
export function mastodonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS,
  });
}

/** `401` — missing/unknown/revoked bearer token (Mastodon's wording). */
export function invalidToken(): Response {
  return mastodonError(401, "The access token is invalid");
}

/** `404` — anything unrouted under `/api/` (Mastodon's wording). */
export function recordNotFound(): Response {
  return mastodonError(404, "Record not found");
}

/** `422` — an app-level (`client_credentials`) token on an account endpoint. */
export function accountRequired(): Response {
  return mastodonError(422, "This method requires an authenticated user.");
}
