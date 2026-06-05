/**
 * `@dwk/microsub` — SSRF-safe outbound fetch.
 *
 * A Microsub server fetches user- and feed-supplied URLs: a `follow` discovers
 * a feed at a URL the user typed, polling re-fetches it, and `preview`/`search`
 * fetch an arbitrary URL. Without guardrails any of these could be pointed at
 * the Worker's own network — loopback, the link-local cloud metadata IP
 * (`169.254.169.254`), or RFC 1918 ranges — to exfiltrate credentials or probe
 * internal services. This module is the single choke point every outbound fetch
 * in the package goes through. It:
 *
 * 1. rejects URLs whose host is a private, loopback, link-local, or otherwise
 *    non-public address (or a name like `localhost` / `*.internal`),
 * 2. follows redirects manually, re-validating the host on every `Location`
 *    hop so a public-looking host cannot 302 to an internal one, and capping
 *    the hop count, and
 * 3. bounds the whole operation with a single timeout, so a slow-loris source
 *    cannot pin a poll-queue invocation.
 *
 * Host validation is purely syntactic on the URL host — DNS rebinding (a name
 * that resolves to a private IP) is out of scope here, as the Workers runtime
 * does not expose name resolution to user code. See `spec/packages/microsub.md`
 * and `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
import type { FetchLike } from "./fetch";
import { MicrosubLogEvent } from "./log";

/** Default cap on redirect hops before a fetch is abandoned. */
export const DEFAULT_MAX_REDIRECTS = 5;
/** Default overall timeout (ms) bounding a fetch, redirects included. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** HTTP status codes that carry a `Location` we may follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Machine-readable cause of an {@link SsrfError}. */
export type SsrfReason =
  | "invalid_url"
  | "disallowed_scheme"
  | "blocked_host"
  | "too_many_redirects";

/**
 * Raised when a request is refused on SSRF grounds (blocked host, disallowed
 * scheme, or too many redirects). Callers catch this exactly like a network
 * failure — a blocked attempt looks the same as an unreachable host — but
 * {@link safeFetch} logs it first (event `microsub.ssrf.blocked`) so the single
 * most security-relevant event in the package still produces a signal.
 */
export class SsrfError extends Error {
  readonly reason: SsrfReason;
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
  if (match === null) return null;
  const octets: number[] = [];
  for (let group = 1; group <= 4; group++) {
    const part = match[group];
    if (part === undefined) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
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
  if (!host.includes(":")) return null;
  let str = host;

  const v4Match = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(str);
  const v4Str = v4Match?.[1];
  if (v4Str !== undefined) {
    const v4 = parseIPv4(v4Str);
    if (v4 === null) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = `${str.slice(0, str.length - v4Str.length)}${hi}:${lo}`;
  }

  if (str.indexOf("::") !== str.lastIndexOf("::")) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const token of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  if (str.includes("::")) {
    const parts = str.split("::");
    const left = toGroups(parts[0] ?? "");
    const right = toGroups(parts[1] ?? "");
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const all = toGroups(str);
  if (all === null || all.length !== 8) return null;
  return all;
}

/**
 * True when `groups` (eight 16-bit values) is an IPv6 address that must never
 * be fetched: unspecified, loopback, link-local, site-local, unique-local,
 * multicast, the documentation prefix, or an address that embeds a private
 * IPv4.
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

  const embeddedV4: [number, number, number, number] = [
    g6 >> 8,
    g6 & 0xff,
    g7 >> 8,
    g7 & 0xff,
  ];
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0x0000)
  ) {
    return isPrivateIPv4(embeddedV4);
  }
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
  if (hostname === "") return true;
  const host = (
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  ).replace(/\.$/, "");

  const v4 = parseIPv4(host);
  if (v4 !== null) return isPrivateIPv4(v4);
  const v6 = parseIPv6(host);
  if (v6 !== null) return isPrivateIPv6(v6);
  return isBlockedHostname(host);
}

/**
 * Validate that `rawUrl` is a fetchable public `http(s)` URL, returning the
 * parsed {@link URL}. Throws {@link SsrfError} for an unparseable URL, a
 * non-`http(s)` scheme (e.g. `file:`, `javascript:`), or a private/reserved
 * host.
 */
export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL: ${rawUrl}`, "invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
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

/** Tunables for {@link safeFetch}. */
export interface SafeFetchOptions {
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

/** A completed {@link safeFetch}: the final response and the URL it came from. */
export interface SafeFetchResult {
  readonly response: Response;
  readonly url: string;
}

/**
 * Fetch `rawUrl` through `doFetch` with SSRF guardrails.
 *
 * The initial host and every redirect target are validated with
 * {@link assertPublicUrl}; redirects are followed manually (`redirect:
 * "manual"`) up to `maxRedirects` hops; and a single {@link AbortSignal.timeout}
 * bounds the whole chain. Credential-bearing headers are stripped on a
 * cross-origin redirect, matching what a browser's `fetch` does.
 *
 * @throws {SsrfError} when a host is blocked, a scheme is disallowed, or the
 * redirect cap is exceeded. Other failures (network, timeout) propagate as the
 * underlying fetch rejection. Callers treat any throw as "fetch failed".
 */
export async function safeFetch(
  doFetch: FetchLike,
  rawUrl: string,
  init: RequestInit,
  options?: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxRedirects = options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    init.signal != null
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

  try {
    let currentUrl = assertPublicUrl(rawUrl).toString();
    let currentInit: RequestInit = { ...init };
    for (let hop = 0; ; hop++) {
      const response = await doFetch(currentUrl, {
        ...currentInit,
        redirect: "manual",
        signal,
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, url: currentUrl };
      }

      const location = response.headers.get("location");
      if (location === null || location === "") {
        return { response, url: currentUrl };
      }
      if (hop >= maxRedirects) {
        throw new SsrfError(
          `too many redirects (> ${maxRedirects})`,
          "too_many_redirects",
          new URL(currentUrl).host,
        );
      }

      const next = assertPublicUrl(new URL(location, currentUrl).toString());
      await response.body?.cancel().catch(() => undefined);

      if (currentInit.headers && new URL(currentUrl).origin !== next.origin) {
        const headers = new Headers(currentInit.headers as HeadersInit);
        for (const name of [
          "authorization",
          "cookie",
          "cookie2",
          "proxy-authorization",
          "set-cookie",
        ]) {
          headers.delete(name);
        }
        currentInit = { ...currentInit, headers };
      }
      currentUrl = next.toString();
    }
  } catch (err) {
    if (err instanceof SsrfError) {
      const fields = { reason: err.reason, host: err.host };
      logger.warn(MicrosubLogEvent.SsrfBlocked, fields);
      metrics.count(MicrosubLogEvent.SsrfBlocked, fields);
    }
    throw err;
  }
}
