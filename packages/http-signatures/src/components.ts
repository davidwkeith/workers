/**
 * Covered-component value derivation (RFC 9421 §2.1–2.2), shared by the
 * signature-base builder and the verifier.
 *
 * Supports the derived components needed for request signing — `@method`,
 * `@target-uri`, `@authority`, `@scheme`, `@request-target`, `@path`,
 * `@query` — and any HTTP header field (matched case-insensitively, with
 * multiple field lines folded into one `", "`-joined value per §2.1).
 * Component parameters (`;sf`, `;key`, `;bs`, `@query-param`, …) are not
 * supported and are reported by the caller as malformed.
 */

import type { HttpMessage } from "./types";

/** Build a case-insensitive view of the message's header values, OWS-trimmed. */
function headerMap(headers: HttpMessage["headers"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const joined = Array.isArray(value) ? value.join(", ") : value;
    map.set(name.toLowerCase(), joined.trim().replace(/\s+/g, " "));
  }
  return map;
}

export interface DerivationContext {
  message: HttpMessage;
  url: URL;
  headers: Map<string, string>;
}

/** Parse the message URL once and capture a normalized header view. */
export function derivationContext(
  message: HttpMessage,
): DerivationContext | null {
  let url: URL;
  try {
    url = new URL(message.url);
  } catch {
    return null;
  }
  return { message, url, headers: headerMap(message.headers) };
}

/**
 * Derive the value of a single covered component. Returns `null` when the
 * component is unsupported (a `@`-derived name we do not implement) or absent
 * (a header the message does not carry).
 */
export function deriveComponentValue(
  ctx: DerivationContext,
  name: string,
): string | null {
  if (name.startsWith("@")) {
    switch (name) {
      case "@method":
        return ctx.message.method.toUpperCase();
      case "@target-uri":
        return ctx.url.href;
      case "@authority":
        return ctx.url.host.toLowerCase();
      case "@scheme":
        return ctx.url.protocol.replace(/:$/, "").toLowerCase();
      case "@request-target":
        return `${ctx.url.pathname}${ctx.url.search}`;
      case "@path":
        return ctx.url.pathname;
      case "@query":
        return ctx.url.search === "" ? "?" : ctx.url.search;
      default:
        return null;
    }
  }
  return ctx.headers.get(name.toLowerCase()) ?? null;
}
