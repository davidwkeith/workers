/**
 * Client and bearer authentication over the D1 store. Secrets and tokens are
 * compared only as SHA-256 hashes (constant-time), so neither ever exists in
 * the database and a store dump cannot be replayed.
 */

import type { ClientRecord } from "@dwk/oauth";

import { sha256Hex, timingSafeEqualHex } from "./encoding.js";
import type { MastodonStore, MastodonTokenRecord } from "./store.js";

/**
 * Authenticate an OAuth client from `client_id`/`client_secret` in the form
 * body (`client_secret_post`, Mastodon practice) or an HTTP Basic header.
 * Returns the client record, or `null` when unknown/mismatched.
 */
export async function authenticateClient(
  params: URLSearchParams,
  headers: Headers,
  store: MastodonStore,
): Promise<ClientRecord | null> {
  let clientId = params.get("client_id") ?? "";
  let clientSecret = params.get("client_secret") ?? "";

  const authorization = headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(authorization.slice(6).trim());
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    } catch {
      return null;
    }
  }

  if (!clientId || !clientSecret) return null;
  const client = await store.getClient(clientId);
  if (!client?.clientSecret) return null;
  const presentedHash = await sha256Hex(clientSecret);
  return timingSafeEqualHex(presentedHash, client.clientSecret) ? client : null;
}

/**
 * Authenticate a `Authorization: Bearer` token. Returns the token record, or
 * `null` for a missing/malformed/unknown/revoked token — the caller responds
 * with Mastodon's `401` shape.
 */
export async function authenticateBearer(
  request: Request,
  store: MastodonStore,
): Promise<MastodonTokenRecord | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  const record = await store.getToken(await sha256Hex(token));
  return record && !record.revoked ? record : null;
}

/**
 * Whether a granted token scope string satisfies a required Mastodon scope.
 * A granted broad scope (`write`) covers its granular children
 * (`write:statuses`), matching Mastodon's hierarchy — but not the reverse
 * (`write:statuses` does not grant `write`, nor does `read` grant `write`).
 */
export function tokenHasScope(
  granted: string,
  required: `${"read" | "write"}${"" | `:${string}`}`,
): boolean {
  const [requiredTop] = required.split(":");
  return granted
    .split(/\s+/)
    .filter(Boolean)
    .some((scope) => scope === required || scope === requiredTop);
}
