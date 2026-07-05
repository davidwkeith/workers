/**
 * Outbound delivery for `@dwk/activitypub`: sign an activity and `POST` it to a
 * remote inbox.
 *
 * Delivery targets are attacker-influenced URLs (a follower's advertised inbox),
 * so every target passes a syntactic SSRF guard before any request leaves —
 * rejecting non-HTTPS schemes and private / loopback / link-local hosts so a
 * malicious actor cannot point a delivery at the Worker's own network. (DNS
 * rebinding is out of scope: the Workers runtime does not expose name
 * resolution to user code; see `@dwk/webmention`'s safe-fetch for the same
 * limitation.) The forthcoming `@dwk/http-signatures` package owns the signing
 * primitive; this module wires it to the network.
 */

import { signRequest, type SignerKey } from "./signature.js";

/** Machine-readable cause of a blocked delivery target. */
export type BlockedReason =
  "invalid_url" | "disallowed_scheme" | "blocked_host";

/** Raised when a delivery target is refused on SSRF grounds. */
export class DeliveryBlockedError extends Error {
  readonly reason: BlockedReason;
  constructor(reason: BlockedReason) {
    super(`delivery target blocked: ${reason}`);
    this.name = "DeliveryBlockedError";
    this.reason = reason;
  }
}

/** Parse a canonical dotted-decimal IPv4 host into its four octets. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const value = Number(match[i]);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/** Whether an IPv4 address falls in a private, loopback, or link-local range. */
function isPrivateIPv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** A host name that names the local host or an internal/reserved suffix. */
function isBlockedHostName(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  return (
    lower.endsWith(".localhost") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".local")
  );
}

/**
 * Validate a delivery target URL: HTTPS only, and a public host. Throws a
 * {@link DeliveryBlockedError} on any failure so the caller logs it and drops
 * the row rather than retrying a target that can never be reached.
 */
export function assertPublicHttpsTarget(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DeliveryBlockedError("invalid_url");
  }
  if (parsed.protocol !== "https:") {
    throw new DeliveryBlockedError("disallowed_scheme");
  }
  const host = parsed.hostname;
  const ipv4 = parseIPv4(host);
  if (ipv4 && isPrivateIPv4(ipv4)) {
    throw new DeliveryBlockedError("blocked_host");
  }
  // IPv6 loopback / unique-local / link-local, and bracketed forms.
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    v6 === "::1" ||
    v6.startsWith("fe80:") ||
    v6.startsWith("fc") ||
    v6.startsWith("fd")
  ) {
    throw new DeliveryBlockedError("blocked_host");
  }
  if (isBlockedHostName(host)) {
    throw new DeliveryBlockedError("blocked_host");
  }
  return parsed;
}

/** The outcome of a single delivery attempt. */
export type DeliveryResult =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly retryable: boolean;
    };

/**
 * Sign and `POST` one activity to a remote inbox. A `2xx` is success; `4xx`
 * (except `408`/`429`) is a permanent failure (drop) since the peer rejected the
 * request; `5xx`, `408`, `429`, and network errors are retryable.
 */
export async function deliverActivity(
  inboxUrl: string,
  activityJson: string,
  signer: SignerKey,
  fetchImpl: typeof fetch,
  now: () => number = () => Date.now(),
  timeoutMs = 10_000,
): Promise<DeliveryResult> {
  // Throws DeliveryBlockedError for an unsafe target — the caller drops the row.
  assertPublicHttpsTarget(inboxUrl);

  const body = new TextEncoder().encode(activityJson);
  const signed = await signRequest(inboxUrl, body, signer, { now });

  let response: Response;
  try {
    response = await fetchImpl(inboxUrl, {
      method: "POST",
      headers: signed.headers,
      body: signed.body as BufferSource,
      // A hung peer must not pin the delivery worker; a timeout is retryable.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 0, retryable: true };
  }

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status };
  }
  const retryable =
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 429;
  return { ok: false, status: response.status, retryable };
}
