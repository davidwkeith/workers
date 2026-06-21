/**
 * `@dwk/websub` — signed content distribution.
 *
 * On publish, the hub fetches the topic's current content and `POST`s it to every
 * active subscriber's callback (WebSub §7). When a subscriber registered a
 * `hub.secret`, the body is authenticated with an HMAC signature in the
 * `X-Hub-Signature: <method>=<hex>` header so the subscriber can verify the
 * delivery came from this hub (§8). The digest method is a hub-level config
 * option (`sha256` by default; `sha1`/`sha384`/`sha512` are also permitted by
 * §8 and selected via `signatureAlgorithm`). Deliveries carry `Link` headers
 * advertising
 * the hub (`rel="hub"`) and the topic (`rel="self"`). Every POST goes through
 * {@link safeFetch}. See `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

import {
  hostFromUrl,
  noopLogger,
  noopMetrics,
  type Logger,
  type Metrics,
} from "@dwk/log";
import type { FetchLike } from "./fetch.js";
import { readBytesCapped } from "./fetch.js";
import { WebSubLogEvent } from "./log.js";
import { safeFetch } from "./safe-fetch.js";
import type { Subscription } from "./store.js";

/** A topic's current content, as fetched from the topic URL. */
export interface TopicContent {
  /** The raw body bytes to forward to subscribers. */
  readonly body: Uint8Array;
  /** The topic's `Content-Type`, forwarded verbatim to subscribers. */
  readonly contentType: string;
}

/**
 * The HMAC digest methods WebSub §8 permits for `X-Hub-Signature`. The method
 * name is emitted verbatim as the header's `<method>=` prefix, so it must match
 * the WebSub spelling (`sha1`, not `sha-1`).
 */
export type SignatureAlgorithm = "sha1" | "sha256" | "sha384" | "sha512";

/** Map a WebSub signature method name to its WebCrypto SHA hash name. */
const HASH_FOR_METHOD: Record<SignatureAlgorithm, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

/** WebSub's secure default signature method; SHA-1 interop is opt-in only. */
export const DEFAULT_SIGNATURE_ALGORITHM: SignatureAlgorithm = "sha256";

/** Outcome of delivering content to one subscriber. */
export interface DeliveryResult {
  readonly callback: string;
  /** Whether the callback accepted the delivery (2xx). */
  readonly delivered: boolean;
  /** The delivery's HTTP status (`0` when the POST threw or was blocked). */
  readonly status: number;
}

/**
 * Compute the `X-Hub-Signature` value for `body` under `secret`:
 * `<method>=<lowercase hex HMAC>` (WebSub §8). `method` defaults to the secure
 * `sha256`; WebSub also permits `sha1`/`sha384`/`sha512`. The header prefix is
 * the WebSub method name verbatim (e.g. `sha1=`, not `sha-1=`).
 */
export async function contentSignature(
  secret: string,
  body: Uint8Array,
  method: SignatureAlgorithm = DEFAULT_SIGNATURE_ALGORITHM,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: HASH_FOR_METHOD[method] },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, body as BufferSource);
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${method}=${hex}`;
}

/** Build the `Link` header advertising this hub and the topic (WebSub §5.1). */
export function buildLinkHeader(hubUrl: string, topic: string): string {
  return `<${hubUrl}>; rel="hub", <${topic}>; rel="self"`;
}

/** Inputs shared by distribution helpers. */
export interface DistributeOptions {
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  /**
   * HMAC method used for the `X-Hub-Signature` header. WebSub §8 has no
   * per-request method parameter, so this is a hub-level choice; it defaults to
   * the secure {@link DEFAULT_SIGNATURE_ALGORITHM} (`sha256`). Set it to `sha1`
   * only for interop with subscribers that require the legacy method.
   */
  readonly signatureAlgorithm?: SignatureAlgorithm;
  /**
   * Media type to forward when the topic response declares no `Content-Type`.
   * WebSub §7 requires the distribution `Content-Type` to correspond to the
   * topic's, so the hub never fabricates a generic `application/octet-stream`:
   * when the topic omits the header and no fallback is configured here, the
   * content is refused rather than mislabeled.
   */
  readonly defaultContentType?: string;
}

/**
 * Outcome of {@link fetchTopicContent}, telling the caller what to do with the
 * queue message:
 *
 * - **`ok`** — the topic's current content, ready to fan out.
 * - **`retry`** — a transient failure (topic unreachable, non-2xx, or an
 *   over-cap body that may be a truncated response): re-enqueue and try later.
 * - **`drop`** — a deterministic refusal that re-fetching cannot fix, so the
 *   caller acks rather than burning retries and re-hammering the topic. Today
 *   this is a topic that declares no `Content-Type` and for which no
 *   {@link DistributeOptions.defaultContentType} fallback is configured, since
 *   forwarding it would mislabel the feed (WebSub §7).
 */
export type TopicFetchResult =
  | { readonly kind: "ok"; readonly content: TopicContent }
  | { readonly kind: "retry" }
  | { readonly kind: "drop" };

/**
 * Fetch the topic's current content through {@link safeFetch}, classifying the
 * outcome as `ok` / `retry` / `drop` (see {@link TopicFetchResult}). A missing,
 * unlabelable `Content-Type` is a `drop` — a permanent format/config error that
 * retrying would only turn into a self-inflicted hammering of the topic — while
 * unreachable/non-2xx/over-cap responses are transient `retry`s.
 */
export async function fetchTopicContent(
  topic: string,
  options?: DistributeOptions,
): Promise<TopicFetchResult> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  let response: Response;
  try {
    const result = await safeFetch(
      doFetch,
      topic,
      { method: "GET" },
      { logger, metrics },
    );
    response = result.response;
  } catch {
    const fields = { topicHost: hostFromUrl(topic), status: 0 };
    logger.warn(WebSubLogEvent.TopicFetchFailed, fields);
    metrics.count(WebSubLogEvent.TopicFetchFailed, fields);
    return { kind: "retry" };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const fields = { topicHost: hostFromUrl(topic), status: response.status };
    logger.warn(WebSubLogEvent.TopicFetchFailed, fields);
    metrics.count(WebSubLogEvent.TopicFetchFailed, fields);
    return { kind: "retry" };
  }

  const contentType =
    response.headers.get("content-type") ?? options?.defaultContentType;
  if (contentType === undefined || contentType === "") {
    // WebSub §7: the distribution Content-Type MUST correspond to the topic's.
    // With neither a topic header nor a configured fallback, forwarding would
    // mislabel the feed. Re-fetching can't conjure a Content-Type, so drop the
    // job (the caller acks) rather than retry — retrying would only clog the
    // queue and re-hammer the topic for a permanent configuration error.
    await response.body?.cancel().catch(() => undefined);
    const fields = { topicHost: hostFromUrl(topic), status: response.status };
    logger.warn(WebSubLogEvent.TopicContentTypeMissing, fields);
    metrics.count(WebSubLogEvent.TopicContentTypeMissing, fields);
    return { kind: "drop" };
  }
  const body = await readBytesCapped(response);
  if (body === null) {
    const fields = { topicHost: hostFromUrl(topic), status: response.status };
    logger.warn(WebSubLogEvent.TopicFetchFailed, fields);
    metrics.count(WebSubLogEvent.TopicFetchFailed, fields);
    return { kind: "retry" };
  }
  return { kind: "ok", content: { body, contentType } };
}

/**
 * Deliver `content` to one subscriber. POSTs the body with the topic's
 * `Content-Type`, the hub/self `Link` header, and — when the subscription
 * carries a secret — the `X-Hub-Signature`. Never throws: a failed or blocked
 * POST is reported as `delivered: false`.
 */
export async function deliverToSubscriber(
  subscription: Subscription,
  content: TopicContent,
  hubUrl: string,
  options?: DistributeOptions,
): Promise<DeliveryResult> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  const headers: Record<string, string> = {
    "content-type": content.contentType,
    link: buildLinkHeader(hubUrl, subscription.topic),
  };
  if (subscription.secret !== null) {
    headers["x-hub-signature"] = await contentSignature(
      subscription.secret,
      content.body,
      options?.signatureAlgorithm ?? DEFAULT_SIGNATURE_ALGORITHM,
    );
  }

  const finish = (delivered: boolean, status: number): DeliveryResult => {
    const fields = {
      callbackHost: hostFromUrl(subscription.callback),
      delivered,
      status,
    };
    logger.info(WebSubLogEvent.DeliveryCompleted, fields);
    metrics.count(WebSubLogEvent.DeliveryCompleted, fields);
    return { callback: subscription.callback, delivered, status };
  };

  try {
    const result = await safeFetch(
      doFetch,
      subscription.callback,
      {
        method: "POST",
        headers,
        // `content.body` is a Uint8Array; pass its backing buffer as the body.
        body: content.body as BodyInit,
      },
      { logger, metrics },
    );
    await result.response.body?.cancel().catch(() => undefined);
    return finish(result.response.ok, result.response.status);
  } catch {
    return finish(false, 0);
  }
}
