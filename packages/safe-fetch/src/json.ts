/**
 * `@dwk/safe-fetch` — SSRF-safe fetch with a JSON convenience wrapper.
 *
 * @packageDocumentation
 */

import { readBodyCapped, MAX_BODY_BYTES } from "./body.js";
import {
  safeFetch,
  type FetchLike,
  type SafeFetchOptions,
} from "./safe-fetch.js";

/** Options for {@link safeFetchJson}, extending {@link SafeFetchOptions}. */
export interface SafeFetchJsonOptions extends SafeFetchOptions {
  /** Cap on the response body in bytes (default {@link MAX_BODY_BYTES}). */
  readonly maxBodyBytes?: number;
}

/**
 * Whether `contentType` is compatible with a JSON body. A missing header is
 * trusted (many static/naive hosts — e.g. a `did:web` document served as a
 * plain file — never set one), as is `text/plain` (the default `Content-Type`
 * `fetch`/`Response` bodies get from a raw string, which is how most of this
 * repo's own server-side handlers respond). Anything else — `text/html` (a
 * login/error page), `application/xml`, `application/octet-stream` — is
 * rejected as a clear content-type mismatch rather than handed to `JSON.parse`.
 */
function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return true;
  }
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    essence === "application/json" ||
    essence === "text/json" ||
    essence === "text/plain" ||
    essence.endsWith("+json")
  );
}

/**
 * Fetch `rawUrl` through `doFetch` with SSRF guardrails, a timeout, and a
 * capped body read, returning the parsed JSON body.
 *
 * @throws {SsrfError} when a host is blocked, the scheme isn't allowed, or
 * the redirect cap is exceeded. Throws a plain `Error` when the response is
 * not ok, the `Content-Type` doesn't look like JSON, the body exceeds the
 * cap, or the body isn't valid JSON.
 */
export async function safeFetchJson(
  doFetch: FetchLike,
  rawUrl: string,
  init: RequestInit = { headers: { accept: "application/json" } },
  options?: SafeFetchJsonOptions,
): Promise<unknown> {
  const { response } = await safeFetch(doFetch, rawUrl, init, options);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`fetch status ${response.status}`);
  }
  if (!isJsonContentType(response.headers.get("content-type"))) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `unexpected content-type: ${response.headers.get("content-type")}`,
    );
  }
  const text = await readBodyCapped(
    response,
    options?.maxBodyBytes ?? MAX_BODY_BYTES,
  );
  if (text === null) {
    throw new Error("response body too large");
  }
  return JSON.parse(text) as unknown;
}
