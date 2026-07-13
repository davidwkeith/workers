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
 * Resolve <esi:include>/<esi:comment>/<esi:remove> markup in `response`'s
 * body, returning a new Response with the same status/headers (except
 * Content-Length, which no longer applies to a streamed body) and a
 * transformed, still-streamed body. Non-text content types pass through
 * untouched. Does not alter cache-control — callers set whatever caching
 * policy they want on the outer response themselves.
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
  headers.delete("content-length");

  return new Response(transformedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
