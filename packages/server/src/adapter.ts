/**
 * Express `(req, res)` ⇄ Web `Request`/`Response` adapter.
 *
 * The composition contract specifies a runtime-neutral handler shape —
 * `(request: Request, env, ctx) => Promise<Response>` — built against the WHATWG
 * platform globals Node ≥ 22 implements natively. This module bridges Node's
 * `http.IncomingMessage`/`http.ServerResponse` (which Express's `req`/`res`
 * extend) to those globals, **streaming bodies in both directions** so large
 * uploads/downloads (Micropub media, R2 blobs) are never buffered — the same
 * non-functional requirement the Cloudflare path honours.
 *
 * It is deliberately Express-free: it programs against `node:http` so the same
 * adapter works under a bare `http.createServer` (used by the tests) and under
 * Express. The Express wiring and routing precedence live in `server.ts`.
 *
 * @see spec/self-hosting.md §6
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Methods that, per the Fetch standard, never carry a request body. */
const BODILESS_METHODS = new Set(["GET", "HEAD"]);

/**
 * Build a Web {@link Request} from an incoming Node request.
 *
 * The absolute URL is reconstructed from the configured public `origin` plus the
 * request's path (`req.url`/`originalUrl`) — **never** the spoofable `Host`
 * header — because the handlers derive identity (issuer, WebID, post URLs) from
 * the configured base URL and a forged `Host` must not feed that.
 *
 * The body is wrapped as a `ReadableStream` (`Readable.toWeb`) rather than
 * buffered, and no body parser is consulted, so the handler receives the
 * untouched stream.
 */
export function toWebRequest(req: IncomingMessage, origin: string): Request {
  const path = requestPath(req);
  const url = new URL(path, origin).toString();
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.append(name, value);
    }
  }

  const init: RequestInit = { method, headers };
  if (!BODILESS_METHODS.has(method.toUpperCase())) {
    // Stream the Node request body through as a Web stream — no buffering.
    // `duplex: "half"` is required when a streaming body is supplied.
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    (init as { duplex?: "half" }).duplex = "half";
  }

  return new Request(url, init);
}

/**
 * The request path as Express/Node sees it. Express adds `originalUrl` (the path
 * before any router rewriting); plain `node:http` only has `url`. Either is the
 * path+query, which is what we join onto the configured origin.
 */
function requestPath(req: IncomingMessage): string {
  const original = (req as { originalUrl?: string }).originalUrl;
  return original ?? req.url ?? "/";
}

/**
 * Write a Web {@link Response} out to a Node response, streaming the body.
 *
 * Status and headers are copied across (including multiple `Set-Cookie` headers
 * via `Headers.getSetCookie`), then `response.body` is piped out with
 * `Readable.fromWeb(...)` so blob downloads are never fully buffered in memory.
 */
export async function sendWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  // Multiple Set-Cookie headers must be emitted as separate header lines;
  // `Headers.forEach` folds them into one comma-joined value, which is invalid.
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    res.setHeader(name, value);
  });
  if (setCookies.length > 0) res.setHeader("set-cookie", setCookies);

  res.statusCode = response.status;

  if (response.body === null) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  // `pipeline` pipes, awaits completion, and destroys both streams on error,
  // so a client disconnect or upstream error can't leak the source stream.
  await pipeline(nodeStream, res);
}
