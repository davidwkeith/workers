/**
 * The WebFinger fetch handler (RFC 7033): a stateless `GET` endpoint, mountable
 * at `/.well-known/webfinger`, that dispatches on the `resource` query parameter,
 * returns the matching JRD (`rel`-filtered), and otherwise distinguishes a
 * missing or malformed parameter (`400`) from an uncontrolled resource (`404`).
 * Discovery data is public, so every response carries permissive CORS (§10.2).
 */

import { hostFromUrl, type LogFields } from "@dwk/log";

import {
  resolveConfig,
  type ResolvedConfig,
  type WebfingerConfig,
} from "./config";
import { buildJrd } from "./jrd";
import { WebfingerLogEvent } from "./log";
import { isWellFormedResource } from "./resource";

/**
 * Cloudflare bindings required by the WebFinger handler: **none**. The resource
 * mapping is config-supplied (composition contract), so this fragment is empty
 * and contributes nothing to the composed Worker's `Env`.
 */
export type WebfingerEnv = Record<never, never>;

/** A `fetch`-compatible Worker handler. */
export type WebfingerHandler = (
  request: Request,
  env: WebfingerEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Media type for a JSON Resource Descriptor (RFC 7033 §10.2). */
const JRD_CONTENT_TYPE = "application/jrd+json; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * WebFinger serves public discovery data to any origin, so every response —
 * success or error — advertises permissive CORS per RFC 7033 §10.2.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
};

/**
 * Reduce a queried `resource` to its host for logging: the domain of an
 * `acct:`/`mailto:` handle, or the host of an `https:`/`http:` URI. The local
 * part (the user identifier) is deliberately dropped — only the domain is
 * recorded (see `log.ts`).
 */
function resourceHost(resource: string): string | undefined {
  if (/^(acct|mailto):/i.test(resource)) {
    const at = resource.lastIndexOf("@");
    if (at !== -1) {
      const host = resource.slice(at + 1).toLowerCase();
      return host.length > 0 ? host : undefined;
    }
    return undefined;
  }
  return hostFromUrl(resource);
}

/**
 * Emit a structured event on both the logger and the metrics seam, which share
 * one event vocabulary (see `@dwk/log`): `warn` for rejections, `info` for a
 * resolved lookup. Callers pass only sanitized hosts, reason codes, and counts.
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

function jrdResponse(body: string, method: string): Response {
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: { "content-type": JRD_CONTENT_TYPE, ...CORS_HEADERS },
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
 * Build the WebFinger handler from configuration.
 *
 * The returned handler is mountable at `/.well-known/webfinger`. It accepts
 * `GET` (and `HEAD`): a request with no `resource` parameter — or a malformed
 * one (no scheme / unparseable URI, RFC 7033 §4.2) — gets `400`; a `resource`
 * this server does not control gets `404`; a match gets `200` with an
 * `application/jrd+json` body whose `subject` echoes the queried URI, filtered by
 * any `rel` parameters. `OPTIONS` returns a CORS preflight; other methods get
 * `405`. Fails loudly at construction if no resource source is configured.
 */
export function createWebfinger(config: WebfingerConfig): WebfingerHandler {
  const resolved = resolveConfig(config);

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
      emit(resolved, "warn", WebfingerLogEvent.Rejected, {
        reason: "method_not_allowed",
      });
      return errorResponse(405, "method_not_allowed: use GET", {
        allow: "GET, HEAD, OPTIONS",
      });
    }

    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");

    if (resource === null || resource.length === 0) {
      emit(resolved, "warn", WebfingerLogEvent.Rejected, {
        reason: "missing_resource",
      });
      return errorResponse(
        400,
        "missing_resource: the `resource` query parameter is required",
      );
    }

    if (!isWellFormedResource(resource)) {
      emit(resolved, "warn", WebfingerLogEvent.Rejected, {
        reason: "malformed_resource",
        resourceHost: resourceHost(resource),
      });
      return errorResponse(
        400,
        "malformed_resource: the `resource` query parameter is not a valid URI",
      );
    }

    const rels = url.searchParams.getAll("rel").filter((rel) => rel.length > 0);

    const record = await resolved.resolve(resource, rels);
    if (record === undefined) {
      emit(resolved, "warn", WebfingerLogEvent.Rejected, {
        reason: "not_found",
        resourceHost: resourceHost(resource),
      });
      return errorResponse(
        404,
        "not_found: no descriptor for the requested resource",
      );
    }

    const jrd = buildJrd(resource, record, rels);
    emit(resolved, "info", WebfingerLogEvent.Resolved, {
      resourceHost: resourceHost(resource),
      relCount: rels.length,
    });
    return jrdResponse(JSON.stringify(jrd), method);
  };
}
