/**
 * `POST /webmention/send` — owner-gated trigger for `@dwk/webmention`'s
 * sender (`sendWebmention`). Mirrors `@dwk/activitypub`'s owner `/publish`
 * pattern: the library ships `sendWebmention`/`sendWebmentions`, but nothing
 * in this deployment previously called it, so the webmention.rocks **sender**
 * suite had no way to make the target actually send a mention (issue #405).
 *
 * webmention.rocks/sender drives this by handing back a source-page URL (on
 * its own domain) per discovery edge case and a target URL to notify — this
 * endpoint accepts an arbitrary `{source, target}` pair for exactly that
 * reason, rather than deriving them from a locally published post.
 *
 * Real traffic never hits this: gated by the same shared-secret bearer as
 * `/admin/init` and `/dav-credentials` (`CONFORMANCE_ADMIN_TOKEN`).
 */

import { sendWebmention, type SendResult } from "@dwk/webmention";

import type { ConformanceEnv } from "./config.js";
import { timingSafeEqual } from "./timing-safe-equal.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface SendBody {
  readonly source: string;
  readonly target: string;
}

function parseSendBody(value: unknown): SendBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { source, target } = value as Record<string, unknown>;
  if (typeof source !== "string" || source.length === 0) return null;
  if (typeof target !== "string" || target.length === 0) return null;
  return { source, target };
}

/**
 * Build the `POST /webmention/send` handler. Requires
 * `Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN`; anything else is 401.
 * Accepts a JSON body `{"source": "...", "target": "..."}` and returns the
 * library's {@link SendResult} as JSON.
 */
export function createWebmentionSendTrigger(
  env: ConformanceEnv,
): (request: Request) => Promise<Response> {
  return async (request) => {
    // Refuse outright when the secret is unset — otherwise a literal
    // "Bearer undefined" header would authenticate.
    const auth = request.headers.get("authorization");
    if (
      !env.CONFORMANCE_ADMIN_TOKEN ||
      auth === null ||
      !timingSafeEqual(auth, `Bearer ${env.CONFORMANCE_ADMIN_TOKEN}`)
    ) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    if (request.method.toUpperCase() !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    const body = parseSendBody(parsed);
    if (body === null) {
      return jsonResponse(400, {
        error: "invalid_request",
        message: "expected a JSON body with non-empty source and target",
      });
    }

    const result: SendResult = await sendWebmention(body.source, body.target);
    return jsonResponse(200, result);
  };
}
