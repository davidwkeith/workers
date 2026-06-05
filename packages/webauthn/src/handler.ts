/**
 * The stateless WebAuthn relying-party front door.
 *
 * It routes the four ceremony steps — `/register/options`, `/register/verify`,
 * `/authenticate/options`, `/authenticate/verify` — to the per-relying-party
 * Durable Object, which owns all challenge and credential state. The handler is
 * mountable under any path prefix because it identifies the step by the *tail*
 * of the request path, and it injects the trusted clock and forwarded config the
 * DO needs (the DO cannot hold the injected logger/metrics/clock itself). It
 * emits each ceremony outcome on the wired logger and metrics seams.
 */

import { type LogFields } from "@dwk/log";

import {
  INTERNAL_HEADERS,
  forwardedConfig,
  resolveConfig,
  type ResolvedConfig,
  type WebAuthnConfig,
  type WebAuthnEnv,
  type WebAuthnOperation,
} from "./config";

/** A `fetch`-compatible Worker handler. */
export type WebAuthnHandler = (
  request: Request,
  env: WebAuthnEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Map a request path tail to a ceremony operation, or `null` if unmatched. */
function operationForPath(pathname: string): WebAuthnOperation | null {
  if (pathname.endsWith("/register/options")) return "register/options";
  if (pathname.endsWith("/register/verify")) return "register/verify";
  if (pathname.endsWith("/authenticate/options")) return "authenticate/options";
  if (pathname.endsWith("/authenticate/verify")) return "authenticate/verify";
  return null;
}

/** Fail loudly if a required Cloudflare binding is missing (no silent degradation). */
function assertBindings(env: WebAuthnEnv): void {
  if (!env.WEBAUTHN) {
    throw new Error(
      "@dwk/webauthn: missing required Durable Object binding `WEBAUTHN`",
    );
  }
}

/** Emit a structured event on both the logger and the metrics seam. */
function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

/**
 * Translate the Durable Object's outcome headers into a structured event on the
 * injected seams, then strip those internal headers before the response reaches
 * the client. A rejection (any non-2xx) logs at `warn` with its stable reason;
 * a success logs at `info`.
 */
function logOutcome(config: ResolvedConfig, response: Response): Response {
  const event = response.headers.get(INTERNAL_HEADERS.event);
  if (event) {
    const reason = response.headers.get(INTERNAL_HEADERS.reason);
    if (response.ok) {
      emit(config, "info", event);
    } else {
      emit(config, "warn", event, reason ? { reason } : undefined);
    }
  }

  const headers = new Headers(response.headers);
  headers.delete(INTERNAL_HEADERS.event);
  headers.delete(INTERNAL_HEADERS.reason);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Build the internal DO request: forwarded config, trusted clock, op, body. */
function internalRequest(
  request: Request,
  config: ResolvedConfig,
  op: WebAuthnOperation,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    [INTERNAL_HEADERS.op]: op,
    [INTERNAL_HEADERS.config]: JSON.stringify(forwardedConfig(config)),
    [INTERNAL_HEADERS.now]: String(config.now()),
  });
  return new Request(request.url, {
    method: "POST",
    headers,
    body: request.body,
  });
}

/**
 * Create the stateless WebAuthn relying-party handler. All four ceremony steps
 * are `POST`; anything else is `405`. Unmatched paths are `404`.
 */
export function createWebAuthn(config: WebAuthnConfig): WebAuthnHandler {
  const resolved = resolveConfig(config);

  return async (request, env, _ctx) => {
    assertBindings(env);

    const op = operationForPath(new URL(request.url).pathname);
    if (op === null) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method.toUpperCase() !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    // One Durable Object per relying party, keyed by the rpId (no sharding).
    const id = env.WEBAUTHN.idFromName(resolved.rpId);
    const response = await env.WEBAUTHN.get(id).fetch(
      internalRequest(request, resolved, op),
    );
    return logOutcome(resolved, response);
  };
}
