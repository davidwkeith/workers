/**
 * `@dwk/websub` — signed content distribution.
 *
 * On publish, the hub fetches the topic's current content and `POST`s it to every
 * active subscriber's callback (WebSub §7). When a subscriber registered a
 * `hub.secret`, the body is authenticated with an **HMAC-SHA256** signature in
 * the `X-Hub-Signature: sha256=<hex>` header so the subscriber can verify the
 * delivery came from this hub (§8). Deliveries carry `Link` headers advertising
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
import type { FetchLike } from "./fetch";
import { readBytesCapped } from "./fetch";
import { WebSubLogEvent } from "./log";
import { safeFetch } from "./safe-fetch";
import type { Subscription } from "./store";

/** A topic's current content, as fetched from the topic URL. */
export interface TopicContent {
  /** The raw body bytes to forward to subscribers. */
  readonly body: Uint8Array;
  /** The topic's `Content-Type`, forwarded verbatim to subscribers. */
  readonly contentType: string;
}

/** Default media type when the topic response declares no `Content-Type`. */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

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
 * `sha256=<lowercase hex HMAC-SHA256>` (WebSub §8).
 */
export async function contentSignature(
  secret: string,
  body: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, body as BufferSource);
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
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
}

/**
 * Fetch the topic's current content through {@link safeFetch}. Returns `null`
 * when the topic is unreachable, returns a non-2xx, or its body exceeds the cap;
 * the caller logs and (typically) retries.
 */
export async function fetchTopicContent(
  topic: string,
  options?: DistributeOptions,
): Promise<TopicContent | null> {
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
    return null;
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const fields = { topicHost: hostFromUrl(topic), status: response.status };
    logger.warn(WebSubLogEvent.TopicFetchFailed, fields);
    metrics.count(WebSubLogEvent.TopicFetchFailed, fields);
    return null;
  }

  const contentType =
    response.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE;
  const body = await readBytesCapped(response);
  if (body === null) {
    const fields = { topicHost: hostFromUrl(topic), status: response.status };
    logger.warn(WebSubLogEvent.TopicFetchFailed, fields);
    metrics.count(WebSubLogEvent.TopicFetchFailed, fields);
    return null;
  }
  return { body, contentType };
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
