/**
 * XRPC plumbing — the request/response conventions of AT Protocol's HTTP API
 * (`/xrpc/<nsid>`). XRPC is "just JSON over HTTP" with a uniform error envelope
 * (`{ error, message }`) and NSID-named methods, so this module is small: JSON
 * helpers, the error shape, and the syntactic validators (NSID, record key) the
 * `com.atproto.repo.*` methods share.
 *
 * Pure and runtime-free.
 */

import type { CborValue } from "./cbor.js";

/** A structured XRPC error, surfaced with the `error` name clients switch on. */
export class XrpcError extends Error {
  readonly status: number;
  readonly errorName: string;
  constructor(status: number, errorName: string, message?: string) {
    super(message ?? errorName);
    this.name = "XrpcError";
    this.status = status;
    this.errorName = errorName;
  }
}

/** 400 InvalidRequest. */
export function invalidRequest(message: string): XrpcError {
  return new XrpcError(400, "InvalidRequest", message);
}

/** 401 AuthenticationRequired. */
export function authRequired(message = "Authentication required"): XrpcError {
  return new XrpcError(401, "AuthenticationRequired", message);
}

/** 403 Forbidden. */
export function forbidden(message = "Forbidden"): XrpcError {
  return new XrpcError(403, "Forbidden", message);
}

/** A named error with a custom error name (e.g. `RecordNotFound`). */
export function namedError(
  status: number,
  errorName: string,
  message?: string,
): XrpcError {
  return new XrpcError(status, errorName, message);
}

/** A JSON response with the given status. */
export function jsonResponse(body: CborValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Render any error as the XRPC error envelope. */
export function errorResponse(error: unknown): Response {
  if (error instanceof XrpcError) {
    return jsonResponse(
      { error: error.errorName, message: error.message },
      error.status,
    );
  }
  // Unexpected errors are otherwise invisible: the DO only ever gets a no-op
  // logger forwarded across the fetch() boundary (functions don't survive the
  // JSON.stringify that carries config across it), so console.error here is
  // the only surviving signal at this layer. The front door records an
  // aggregate signal via the real injected logger/metrics — see handler.ts.
  console.error("@dwk/atproto-pds: unhandled XRPC error", error);
  return jsonResponse(
    { error: "InternalServerError", message: "Internal server error" },
    500,
  );
}

// AT Protocol NSID syntax (https://atproto.com/specs/nsid):
//  - at least 3 dot-separated segments — the authority (every segment but the
//    last) must itself be ≥2 segments, plus the trailing name segment;
//  - every segment starts with an ASCII letter, is 1–63 chars of letters,
//    digits and hyphens, and may not end with a hyphen;
//  - the final *name* segment is letters and digits only (no hyphens);
//  - the whole NSID is at most 317 chars.
const NSID_AUTHORITY_SEGMENT = "[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";
const NSID_NAME_SEGMENT = "[a-zA-Z][a-zA-Z0-9]{0,62}";
const NSID_RE = new RegExp(
  `^(?:${NSID_AUTHORITY_SEGMENT}\\.){2,}${NSID_NAME_SEGMENT}$`,
);

/** Whether a string is a syntactically valid NSID (collection / lexicon id). */
export function isValidNsid(nsid: string): boolean {
  return nsid.length <= 317 && NSID_RE.test(nsid);
}

/** Whether a string is a valid record key (`rkey`). */
export function isValidRecordKey(rkey: string): boolean {
  if (rkey.length < 1 || rkey.length > 512) return false;
  if (rkey === "." || rkey === "..") return false;
  return /^[a-zA-Z0-9._~:-]+$/.test(rkey);
}
