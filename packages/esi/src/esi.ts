/**
 * `processEsi` — the public `Response` wrapper + content-type gate.
 */

import {
  createEsiTransformStream,
  type EsiTransformOptions,
} from "./transform.js";

export type EsiOptions = EsiTransformOptions;

const TEXTUAL_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
]);

function isTextualContentType(header: string | null): boolean {
  if (header === null) {
    return false;
  }
  const mime = header.split(";")[0]?.trim().toLowerCase();
  return mime !== undefined && TEXTUAL_CONTENT_TYPES.has(mime);
}

/**
 * Response validator headers that describe the *origin* body verbatim and so
 * no longer apply once fragments have been spliced in — carrying them
 * through unchanged would let a client's `If-None-Match`/`If-Modified-Since`
 * on the transformed response validate against bytes that never actually
 * matched the transformed body, serving a stale cached representation on a
 * `304`.
 */
const STALE_AFTER_TRANSFORM_HEADERS = [
  "content-length",
  "etag",
  "last-modified",
];

/**
 * Resolve <esi:include>/<esi:comment>/<esi:remove> markup in `response`'s
 * body, returning a new Response with the same status/headers (except
 * Content-Length/ETag/Last-Modified, which no longer describe the
 * transformed, still-streamed body) and that transformed body. Non-text
 * content types pass through untouched. Does not alter cache-control —
 * callers set whatever caching policy they want on the outer response
 * themselves.
 */
export function processEsi(
  response: Response,
  options: EsiOptions = {},
): Response {
  if (
    response.body === null ||
    !isTextualContentType(response.headers.get("content-type"))
  ) {
    return response;
  }

  const transformedBody = response.body.pipeThrough(
    createEsiTransformStream(options),
  );
  const headers = new Headers(response.headers);
  for (const name of STALE_AFTER_TRANSFORM_HEADERS) {
    headers.delete(name);
  }

  return new Response(transformedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
