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
import type { R2Bucket } from "@cloudflare/workers-types";
import { readBytesCapped, safeFetch, type FetchLike } from "@dwk/safe-fetch";
import { WebSubLogEvent } from "./log.js";

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

/**
 * Cap on a fetched topic's body (4 MB). Kept local rather than relying on
 * `@dwk/safe-fetch`'s smaller 2 MB default, since this hub has always
 * accepted up to 4 MB topics and that behavior must not silently regress.
 */
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * Largest body carried inline in a per-subscriber queue message. Cloudflare
 * Queue messages are capped at ~128 KB; 96 KB leaves comfortable headroom for
 * the message's other fields (callback, secret, content type) and the queue's
 * own serialization overhead. A snapshot over this size is staged once in R2
 * (see {@link WebSubEnv.WEBSUB_CONTENT}) and referenced by key instead.
 */
export const MAX_INLINE_BODY_BYTES = 96 * 1024;

/**
 * The minimal subscription facts one delivery needs: where to POST, which topic
 * to advertise, and the HMAC secret (or `null`). A full {@link Subscription} is
 * assignable to this, and so is a per-subscriber {@link DeliverJob} reconstituted
 * off the queue — the delivery path never re-reads the store.
 */
export interface DeliveryTarget {
  readonly callback: string;
  readonly topic: string;
  readonly secret: string | null;
}

/**
 * Stage a distribution snapshot in R2 under a fresh random key and return that
 * key. Used by the fan-out planner when a body is too large to inline in a queue
 * message; the per-subscriber deliver jobs read it back with
 * {@link readStagedContent}. Only the body bytes are stored — the
 * `Content-Type` rides in each (small) deliver job.
 */
export async function stageContent(
  bucket: R2Bucket,
  body: Uint8Array,
): Promise<string> {
  const key = `websub-staging/${crypto.randomUUID()}`;
  await bucket.put(key, body);
  return key;
}

/**
 * Read a snapshot previously staged by {@link stageContent}. Returns `null` when
 * the object is absent (e.g. it was reclaimed by the bucket's lifecycle rule
 * before a slow delivery retried) — the caller drops that delivery rather than
 * retrying forever, since re-fetching cannot conjure an expired snapshot.
 */
export async function readStagedContent(
  bucket: R2Bucket,
  key: string,
): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (object === null) {
    return null;
  }
  return new Uint8Array(await object.arrayBuffer());
}

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
   * Local-dev opt-in passed through to `@dwk/safe-fetch`'s `allowedHosts`:
   * exact `host[:port]` entries exempted from the SSRF private/loopback host
   * block (e.g. `["localhost:4321"]` under `wrangler dev --local`). Never
   * enable in a production composition.
   */
  readonly fetchAllowedHosts?: readonly string[];
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
      {
        logger,
        metrics,
        logEvent: WebSubLogEvent.SsrfBlocked,
        stripHeadersCrossOrigin: ["x-hub-signature"],
        allowedHosts: options?.fetchAllowedHosts,
      },
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
  const body = await readBytesCapped(response, MAX_CONTENT_BYTES);
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
  subscription: DeliveryTarget,
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
      {
        logger,
        metrics,
        logEvent: WebSubLogEvent.SsrfBlocked,
        stripHeadersCrossOrigin: ["x-hub-signature"],
        allowedHosts: options?.fetchAllowedHosts,
      },
    );
    await result.response.body?.cancel().catch(() => undefined);
    return finish(result.response.ok, result.response.status);
  } catch {
    return finish(false, 0);
  }
}
