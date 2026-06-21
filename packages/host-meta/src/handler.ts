/**
 * The host-meta fetch handler (RFC 6415): a stateless `GET` endpoint, mountable
 * at both `/.well-known/host-meta` and `/.well-known/host-meta.json`, that
 * serves one request-invariant document in either the XRD (`application/xrd+xml`,
 * the default) or JRD (`application/jrd+json`) representation depending on
 * content negotiation. Discovery data is public, so every response carries
 * permissive CORS (mirroring RFC 7033 §10.2).
 */

import { type LogFields } from "@dwk/log";

import {
  resolveConfig,
  type ResolvedConfig,
  type HostMetaConfig,
} from "./config.js";
import { HostMetaLogEvent } from "./log.js";
import { negotiateFormat, type Format } from "./negotiation.js";

/**
 * Cloudflare bindings required by the host-meta handler: **none**. The document
 * is config-supplied (composition contract), so this fragment is empty and
 * contributes nothing to the composed Worker's `Env`.
 */
export type HostMetaEnv = Record<never, never>;

/** A `fetch`-compatible Worker handler. */
export type HostMetaHandler = (
  request: Request,
  env: HostMetaEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Media type for an XRD document (RFC 6415 §2). */
const XRD_CONTENT_TYPE = "application/xrd+xml; charset=utf-8";
/** Media type for a JSON Resource Descriptor (RFC 7033 §10.2). */
const JRD_CONTENT_TYPE = "application/jrd+json; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * host-meta serves public discovery data to any origin, so every response —
 * success or error — advertises permissive CORS, mirroring the WebFinger policy
 * (RFC 7033 §10.2) it links to.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
};

/**
 * Emit a structured event on both the logger and the metrics seam, which share
 * one event vocabulary (see `@dwk/log`): `warn` for rejections, `info` for a
 * served document.
 */
function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

function documentResponse(
  body: string,
  contentLength: string,
  format: Format,
  method: string,
): Response {
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": format === "jrd" ? JRD_CONTENT_TYPE : XRD_CONTENT_TYPE,
      // RFC 9110 §9.3.2: a HEAD response carries the same Content-Length the
      // corresponding GET would, so it is set explicitly (the body is dropped
      // for HEAD, which would otherwise omit the header).
      "content-length": contentLength,
      // The representation varies on the negotiated content type; advertise it
      // so shared caches key XRD and JRD responses separately.
      vary: "Accept",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(
  status: number,
  message: string,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": TEXT_CONTENT_TYPE,
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Build the host-meta handler from configuration.
 *
 * The returned handler is mountable at `/.well-known/host-meta` and
 * `/.well-known/host-meta.json`. It accepts `GET` (and `HEAD`) and returns
 * `200` with the host-meta document: XRD by default, JRD when the client
 * prefers it (`?format=json`, the `host-meta.json` path, or an Accept header
 * favouring `application/jrd+json`). `OPTIONS` returns a CORS preflight; other
 * methods get `405`. Fails loudly at construction if no link source is
 * configured.
 */
export function createHostMeta(config: HostMetaConfig): HostMetaHandler {
  const resolved = resolveConfig(config);

  // Pre-serialized bodies and their byte lengths, computed once: nothing about
  // the document varies per request, so a response is pure header assembly.
  const byteLength = (body: string): string =>
    String(new TextEncoder().encode(body).length);
  const representations: Record<Format, { body: string; length: string }> = {
    xrd: { body: resolved.xrdBody, length: byteLength(resolved.xrdBody) },
    jrd: { body: resolved.jrdBody, length: byteLength(resolved.jrdBody) },
  };

  return async (request, _env, _ctx) => {
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "*",
        },
      });
    }

    if (method !== "GET" && method !== "HEAD") {
      emit(resolved, "warn", HostMetaLogEvent.Rejected, {
        reason: "method_not_allowed",
      });
      return errorResponse(405, "method_not_allowed: use GET", {
        allow: "GET, HEAD, OPTIONS",
      });
    }

    const url = new URL(request.url);
    const isJsonPath = url.pathname.endsWith(".json");
    const format = negotiateFormat(
      url,
      request.headers.get("accept"),
      isJsonPath,
    );

    const { body, length } = representations[format];
    emit(resolved, "info", HostMetaLogEvent.Served, { format });
    return documentResponse(body, length, format, method);
  };
}
