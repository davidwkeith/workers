/**
 * `@dwk/vc` — SSRF-safe outbound fetch and a capped body read.
 *
 * Verifying a credential with a `credentialStatus` entry means fetching a
 * `statusListCredential` URL taken straight from the (attacker-controlled)
 * credential under verification. Without guardrails that URL could point at
 * the Worker's own network — loopback, the link-local cloud metadata IP
 * (`169.254.169.254`), or RFC 1918 ranges — to exfiltrate credentials or probe
 * internal services, and an unbounded fetch/body read risks pinning the
 * invocation or an OOM (the Worker memory limit is 128 MB). This module is an
 * interim, `@dwk/vc`-local copy of the hardened primitives already proven in
 * `@dwk/webmention`'s `safe-fetch.ts`/`fetch.ts` (extracting them into a
 * shared cross-standard lib is tracked separately). See
 * `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

/** A minimal, injectable `fetch` signature. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Default cap on redirect hops before a fetch is abandoned. */
export const DEFAULT_MAX_REDIRECTS = 5;
/** Default overall timeout (ms) bounding a fetch, redirects included. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Default cap on a fetched status list credential body (1 MB). Even a
 * 100k-entry gzipped bitstring is KB-scale, so this is generous headroom
 * while still refusing to buffer an unbounded body.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** HTTP status codes that carry a `Location` we may follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Machine-readable cause of an {@link SsrfError}, suitable for logging as a
 * structured field (no free-text parsing required).
 */
export type SsrfReason =
  "invalid_url" | "disallowed_scheme" | "blocked_host" | "too_many_redirects";

/**
 * Raised when a request is refused on SSRF grounds (blocked host, disallowed
 * scheme, or too many redirects).
 */
export class SsrfError extends Error {
  /** Machine-readable cause. */
  readonly reason: SsrfReason;
  /** The offending host (name plus any port), when one is known. */
  readonly host?: string;
  constructor(message: string, reason: SsrfReason, host?: string) {
    super(message);
    this.name = "SsrfError";
    this.reason = reason;
    this.host = host;
  }
}

/** Parse a canonical dotted-decimal IPv4 host into its four octets. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) {
    return null;
  }
  const octets: number[] = [];
  for (let group = 1; group <= 4; group++) {
    const part = match[group];
    if (part === undefined) {
      return null;
    }
    const octet = Number.parseInt(part, 10);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return octets as [number, number, number, number];
}

/**
 * True when `octets` falls in a range that must never be fetched from inside
 * the Worker's network: this-network, loopback, link-local (incl. the cloud
 * metadata IP), the RFC 1918 private blocks, CGNAT, IETF protocol/benchmark
 * assignments, and the multicast/reserved/broadcast space.
 */
function isPrivateIPv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network", incl. 0.0.0.0)
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/**
 * Parse an IPv6 host (brackets already stripped) into its eight 16-bit groups,
 * expanding `::` compression and any trailing embedded IPv4 literal. Returns
 * `null` when `host` is not a valid IPv6 address.
 */
function parseIPv6(host: string): number[] | null {
  if (!host.includes(":")) {
    return null;
  }
  let str = host;

  // Fold a trailing embedded IPv4 literal (e.g. ::ffff:127.0.0.1) into two
  // hex groups so the rest can be parsed uniformly.
  const v4Match = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(str);
  const v4Str = v4Match?.[1];
  if (v4Str !== undefined) {
    const v4 = parseIPv4(v4Str);
    if (v4 === null) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = `${str.slice(0, str.length - v4Str.length)}${hi}:${lo}`;
  }

  // At most one "::" compression marker is allowed.
  if (str.indexOf("::") !== str.lastIndexOf("::")) {
    return null;
  }

  const toGroups = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups: number[] = [];
    for (const token of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) {
        return null;
      }
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  if (str.includes("::")) {
    const parts = str.split("::");
    const left = toGroups(parts[0] ?? "");
    const right = toGroups(parts[1] ?? "");
    if (left === null || right === null) {
      return null;
    }
    const missing = 8 - left.length - right.length;
    if (missing < 1) {
      return null;
    }
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const all = toGroups(str);
  if (all === null || all.length !== 8) {
    return null;
  }
  return all;
}

/**
 * True when `groups` (eight 16-bit values) is an IPv6 address that must never
 * be fetched: unspecified, loopback, link-local, site-local, unique-local,
 * multicast, the documentation prefix, or an address that embeds an IPv4
 * (IPv4-mapped `::ffff:0:0/96`, deprecated IPv4-compatible `::/96`, or NAT64
 * `64:ff9b::/96`) whose embedded IPv4 is itself private.
 */
function isPrivateIPv6(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  if (groups.every((group) => group === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1 loopback
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 documentation

  // Extract the IPv4 embedded in the low 32 bits.
  const embeddedV4: [number, number, number, number] = [
    g6 >> 8,
    g6 & 0xff,
    g7 >> 8,
    g7 & 0xff,
  ];
  // ::ffff:0:0/96 IPv4-mapped and ::/96 deprecated IPv4-compatible.
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0x0000)
  ) {
    return isPrivateIPv4(embeddedV4);
  }
  // 64:ff9b::/96 NAT64 well-known prefix.
  if (
    first === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPrivateIPv4(embeddedV4);
  }
  return false;
}

/** Hostnames (non-IP) that are never public and must never be fetched. */
function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  );
}

/**
 * Decide whether a URL host is private, loopback, link-local, or otherwise
 * not safe to fetch from inside the Worker's network. Accepts the raw
 * `URL.hostname` form (IPv6 hosts may arrive wrapped in `[...]`).
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  if (hostname === "") {
    return true;
  }
  // Strip IPv6 brackets and a trailing dot. A trailing dot makes a name an
  // FQDN that still resolves (e.g. `localhost.` → 127.0.0.1) but would slip
  // past the string checks below if left in place.
  const host = (
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  ).replace(/\.$/, "");

  const v4 = parseIPv4(host);
  if (v4 !== null) {
    return isPrivateIPv4(v4);
  }
  const v6 = parseIPv6(host);
  if (v6 !== null) {
    return isPrivateIPv6(v6);
  }
  return isBlockedHostname(host);
}

/**
 * Validate that `rawUrl` is a fetchable public `https:` URL, returning the
 * parsed {@link URL}. Throws {@link SsrfError} for an unparseable URL, a
 * non-`https:` scheme, or a private/reserved host.
 */
export function assertPublicHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL: ${rawUrl}`, "invalid_url");
  }
  if (url.protocol !== "https:") {
    throw new SsrfError(
      `disallowed scheme: ${url.protocol}`,
      "disallowed_scheme",
      url.hostname,
    );
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    throw new SsrfError(
      `blocked host: ${url.hostname}`,
      "blocked_host",
      url.hostname,
    );
  }
  return url;
}

/** Tunables for {@link safeFetchJson}. */
export interface SafeFetchOptions {
  /** Maximum redirect hops to follow (default {@link DEFAULT_MAX_REDIRECTS}). */
  readonly maxRedirects?: number;
  /** Overall timeout in ms, redirects included (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Cap on the response body in bytes (default {@link MAX_BODY_BYTES}). */
  readonly maxBodyBytes?: number;
  /** Logger for SSRF blocks; defaults to a no-op (see `@dwk/log`). */
  readonly logger?: Logger;
  /** Metrics sink for SSRF-block counters; defaults to a no-op (see `@dwk/log`). */
  readonly metrics?: Metrics;
  /** Stable event name to log/count an SSRF block under. */
  readonly logEvent?: string;
  /** Override the fetch implementation (defaults to the global `fetch`). */
  readonly fetch?: FetchLike;
}

/**
 * Read a response body as text, refusing bodies larger than `maxBytes`.
 *
 * A declared `Content-Length` over the cap is rejected up front; the stream is
 * then read incrementally and aborted the moment the cap is exceeded, so a
 * missing or lying `Content-Length` cannot force the whole body into memory.
 * Returns `null` when the body is too large or cannot be read.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      return null;
    }
  }

  const body = response.body;
  if (body === null) {
    try {
      const text = await response.text();
      return text.length > maxBytes ? null : text;
    } catch {
      return null;
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Fetch `rawUrl` (an attacker-controlled `statusListCredential` URL) with SSRF
 * guardrails, a timeout, and a capped body read, returning the parsed JSON
 * body. The initial host and every redirect target are validated with
 * {@link assertPublicHttpsUrl}; redirects are followed manually up to
 * `maxRedirects` hops; a single {@link AbortSignal.timeout} bounds the whole
 * chain; and the response body is read via {@link readBodyCapped}.
 *
 * @throws {SsrfError} when a host is blocked, the scheme isn't `https:`, or
 * the redirect cap is exceeded. Throws a plain `Error` when the response is
 * not ok, the body exceeds the cap, or the body isn't valid JSON. Other
 * failures (network, timeout) propagate as the underlying fetch rejection.
 */
export async function safeFetchJson(
  rawUrl: string,
  options?: SafeFetchOptions,
): Promise<unknown> {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options?.maxBodyBytes ?? MAX_BODY_BYTES;
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;
  const logEvent = options?.logEvent ?? "vc.ssrf.blocked";
  const doFetch = options?.fetch ?? (globalThis.fetch as FetchLike);
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    let currentUrl = assertPublicHttpsUrl(rawUrl).toString();
    let response: Response;
    for (let hop = 0; ; hop++) {
      response = await doFetch(currentUrl, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        break;
      }

      const location = response.headers.get("location");
      if (location === null || location === "") {
        break;
      }
      if (hop >= maxRedirects) {
        throw new SsrfError(
          `too many redirects (> ${maxRedirects})`,
          "too_many_redirects",
          new URL(currentUrl).host,
        );
      }
      // Resolve the next hop against the current URL and re-validate its host
      // before following — a public host must not be able to bounce us inward.
      const next = assertPublicHttpsUrl(
        new URL(location, currentUrl).toString(),
      );
      await response.body?.cancel().catch(() => undefined);
      currentUrl = next.toString();
    }

    if (!response.ok) {
      throw new Error(`status list fetch failed: ${response.status}`);
    }
    const text = await readBodyCapped(response, maxBodyBytes);
    if (text === null) {
      throw new Error("status list response too large");
    }
    return JSON.parse(text) as unknown;
  } catch (err) {
    if (err instanceof SsrfError) {
      const fields = { reason: err.reason, host: err.host };
      logger.warn(logEvent, fields);
      metrics.count(logEvent, fields);
    }
    throw err;
  }
}
