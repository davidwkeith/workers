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

import { assertPublicUrl, SsrfError } from "@dwk/safe-fetch";

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

/**
 * Validate a delivery target URL: HTTPS only, and a public host. Delegates to
 * `@dwk/safe-fetch`'s {@link assertPublicUrl} — the repo's single SSRF choke
 * point — rather than a second, hand-rolled copy of the private/reserved-host
 * checks, so delivery targets get the same IPv6 coverage (loopback,
 * unique-local, link-local, 6to4/Teredo/IPv4-mapped forms) as every other
 * attacker-URL fetch in the repo. A hand-rolled IPv6 check here previously
 * missed mapped/6to4/Teredo forms (e.g. `[::ffff:127.0.0.1]`), which
 * `assertPublicUrl` already handles.
 *
 * Throws a {@link DeliveryBlockedError} on any failure so the caller logs it
 * and drops the row rather than retrying a target that can never be reached.
 */
export function assertPublicHttpsTarget(url: string): URL {
  try {
    return assertPublicUrl(url, { allowedSchemes: ["https:"] });
  } catch (error) {
    if (error instanceof SsrfError) {
      const reason: BlockedReason =
        error.reason === "invalid_url" || error.reason === "disallowed_scheme"
          ? error.reason
          : "blocked_host";
      throw new DeliveryBlockedError(reason);
    }
    throw error;
  }
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
