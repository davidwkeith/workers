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
 * limitation.) `signature.ts` owns the signing primitives; this module wires
 * them to the network.
 *
 * Signing "double-knocks": a peer with no known preference is sent an RFC 9421
 * signature first, and if it rejects that with a signature-shaped status
 * (`400`/`401`/`403`) the same body is re-signed with draft-cavage and sent
 * once more. The result reports which profile the peer accepted so the caller
 * can remember draft-cavage peers and skip the first knock next time.
 */

import { assertPublicUrl, safeFetch, SsrfError } from "@dwk/safe-fetch";

import type { SignatureProfile } from "@dwk/http-signatures";

import {
  signRequest,
  signRequestRfc9421,
  type SignedRequest,
  type SignerKey,
} from "./signature.js";

/**
 * Statuses that may mean "I could not verify that signature", and so warrant a
 * second knock with draft-cavage. Mastodon answers `401`; others use `400` or
 * `403`. A `404`/`410`/`422`/`5xx` is not about the signature, so it never
 * triggers the fallback.
 */
const KNOCK_AGAIN_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

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
    if (error instanceof SsrfError)
      throw new DeliveryBlockedError(reasonFor(error));
    throw error;
  }
}

/** Map an `@dwk/safe-fetch` SSRF reason onto this module's narrower vocabulary. */
function reasonFor(error: SsrfError): BlockedReason {
  return error.reason === "invalid_url" || error.reason === "disallowed_scheme"
    ? error.reason
    : "blocked_host";
}

/** The outcome of a single delivery attempt. */
export type DeliveryResult =
  | {
      readonly ok: true;
      readonly status: number;
      /** The signature profile the peer accepted. */
      readonly profile: SignatureProfile;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly retryable: boolean;
    };

/**
 * Sign and `POST` one activity to a remote inbox. A `2xx` is success; `4xx`
 * (except `408`/`429`) is a permanent failure (drop) since the peer rejected the
 * request; `5xx`, `408`, `429`, and network errors are retryable.
 *
 * `preference` is the profile the peer is known to want: `"cavage"` skips the
 * RFC 9421 knock; anything else (including unknown) double-knocks — RFC 9421
 * first, then draft-cavage if the first answer is in {@link KNOCK_AGAIN_STATUSES}.
 */
export async function deliverActivity(
  inboxUrl: string,
  activityJson: string,
  signer: SignerKey,
  fetchImpl: typeof fetch,
  userAgent: string,
  now: () => number = () => Date.now(),
  timeoutMs = 10_000,
  preference?: SignatureProfile,
): Promise<DeliveryResult> {
  // Throws DeliveryBlockedError for an unsafe target — the caller drops the row.
  assertPublicHttpsTarget(inboxUrl);

  const body = new TextEncoder().encode(activityJson);
  const post = (signed: SignedRequest): Promise<Response | null> =>
    postSigned(fetchImpl, inboxUrl, signed, userAgent, timeoutMs);

  let profile: SignatureProfile =
    preference === "cavage" ? "cavage" : "rfc9421";
  let response =
    profile === "cavage"
      ? await post(await signRequest(inboxUrl, body, signer, { now }))
      : await post(await signRequestRfc9421(inboxUrl, body, signer, { now }));
  if (
    profile === "rfc9421" &&
    response !== null &&
    KNOCK_AGAIN_STATUSES.has(response.status)
  ) {
    // The first knock's body is never read; release it before knocking again.
    await response.body?.cancel();
    profile = "cavage";
    response = await post(await signRequest(inboxUrl, body, signer, { now }));
  }
  // Network error or timeout: worth retrying.
  if (response === null) return { ok: false, status: 0, retryable: true };

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status, profile };
  }
  const retryable =
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 429;
  return { ok: false, status: response.status, retryable };
}

/**
 * `POST` one signed delivery. Returns the response, or `null` on a network
 * error or timeout; throws {@link DeliveryBlockedError} if a redirect hop lands
 * on a blocked target.
 */
async function postSigned(
  fetchImpl: typeof fetch,
  inboxUrl: string,
  signed: SignedRequest,
  userAgent: string,
  timeoutMs: number,
): Promise<Response | null> {
  try {
    // Route the POST itself through the SSRF-safe wrapper too, not just the
    // pre-flight check on `inboxUrl`: a hostile inbox can 3xx-redirect a
    // signed delivery to a private/internal target, and only `safeFetch`
    // re-validates every redirect hop (a bare `fetch` with the default
    // `redirect: "follow"` would happily walk it there).
    const result = await safeFetch(
      fetchImpl,
      inboxUrl,
      {
        method: "POST",
        // `User-Agent` is layered on top of (not part of) the signed header
        // set — it isn't covered by the signature, so adding it here doesn't
        // touch signing at all.
        headers: { ...signed.headers, "User-Agent": userAgent },
        body: signed.body as BufferSource,
      },
      { allowedSchemes: ["https:"], timeoutMs },
    );
    return result.response;
  } catch (error) {
    if (error instanceof SsrfError) {
      // A redirect hop landed on a blocked target — this inbox can never be
      // delivered to safely, same as failing the pre-flight check.
      throw new DeliveryBlockedError(reasonFor(error));
    }
    return null;
  }
}
