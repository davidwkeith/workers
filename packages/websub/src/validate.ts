/**
 * `@dwk/websub` — request validation.
 *
 * Subscribe/unsubscribe and publish requests are validated synchronously, before
 * any slow work is enqueued, so a malformed request gets a fast `400` and never
 * reaches the queue. Validation is pure (no I/O) and unit-tests without a Workers
 * runtime. Stable, machine-readable error codes are returned in place of free
 * text. See `spec/packages/websub.md` and WebSub §5–§7.
 *
 * @packageDocumentation
 */

import type { ResolvedConfig } from "./config";

/** WebSub §6.1.1: a `hub.secret` MUST be less than 200 bytes. */
export const MAX_SECRET_BYTES = 200;

/** Machine-readable rejection codes for a subscribe/unsubscribe request. */
export type SubscribeError =
  | "invalid_mode"
  | "callback_required"
  | "callback_not_url"
  | "topic_required"
  | "topic_not_url"
  | "topic_not_supported"
  | "secret_too_long"
  | "invalid_lease_seconds";

/** Machine-readable rejection codes for a publish request. */
export type PublishError =
  | "url_required"
  | "url_not_url"
  | "topic_not_supported";

/** Parsed, validated subscribe/unsubscribe request. */
export interface SubscribeRequest {
  readonly ok: true;
  readonly mode: "subscribe" | "unsubscribe";
  readonly callback: string;
  readonly topic: string;
  /** Requested lease, clamped into the hub's bounds; `undefined` left to the consumer. */
  readonly leaseSeconds: number;
  readonly secret?: string;
}

/** Parsed, validated publish request. */
export interface PublishRequest {
  readonly ok: true;
  readonly mode: "publish";
  readonly topic: string;
}

/** Result of validating a subscribe/unsubscribe request. */
export type SubscribeResult =
  | SubscribeRequest
  | { readonly ok: false; readonly error: SubscribeError };

/** Result of validating a publish request. */
export type PublishResult =
  | PublishRequest
  | { readonly ok: false; readonly error: PublishError };

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The raw `hub.*` fields lifted out of a form body. */
export interface RawHubParams {
  readonly mode: string | null;
  readonly callback: string | null;
  readonly topic: string | null;
  readonly url: string | null;
  readonly leaseSeconds: string | null;
  readonly secret: string | null;
}

/** Lift the `hub.*` fields out of a parsed form body. */
export function readHubParams(form: URLSearchParams): RawHubParams {
  return {
    mode: form.get("hub.mode"),
    callback: form.get("hub.callback"),
    topic: form.get("hub.topic"),
    url: form.get("hub.url"),
    leaseSeconds: form.get("hub.lease_seconds"),
    secret: form.get("hub.secret"),
  };
}

/**
 * Validate a subscribe/unsubscribe request against `config`. Clamps a supplied
 * `hub.lease_seconds` into the hub's bounds and falls back to the default lease
 * when it is absent.
 */
export function validateSubscribe(
  params: RawHubParams,
  config: ResolvedConfig,
): SubscribeResult {
  if (params.mode !== "subscribe" && params.mode !== "unsubscribe") {
    return { ok: false, error: "invalid_mode" };
  }
  if (params.callback === null || params.callback === "") {
    return { ok: false, error: "callback_required" };
  }
  if (!isHttpUrl(params.callback)) {
    return { ok: false, error: "callback_not_url" };
  }
  if (params.topic === null || params.topic === "") {
    return { ok: false, error: "topic_required" };
  }
  if (!isHttpUrl(params.topic)) {
    return { ok: false, error: "topic_not_url" };
  }
  if (!config.isAllowedTopic(params.topic)) {
    return { ok: false, error: "topic_not_supported" };
  }

  let secret: string | undefined;
  if (params.secret !== null && params.secret !== "") {
    if (utf8Length(params.secret) >= MAX_SECRET_BYTES) {
      return { ok: false, error: "secret_too_long" };
    }
    secret = params.secret;
  }

  let leaseSeconds = config.defaultLeaseSeconds;
  if (params.leaseSeconds !== null && params.leaseSeconds !== "") {
    const parsed = Number.parseInt(params.leaseSeconds, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { ok: false, error: "invalid_lease_seconds" };
    }
    leaseSeconds = Math.min(
      Math.max(parsed, config.minLeaseSeconds),
      config.maxLeaseSeconds,
    );
  }

  return {
    ok: true,
    mode: params.mode,
    callback: params.callback,
    topic: params.topic,
    leaseSeconds,
    ...(secret !== undefined ? { secret } : {}),
  };
}

/**
 * Validate a publish request. Accepts the topic in `hub.url` (WebSub §7) and
 * falls back to `hub.topic` for compatibility with older publishers.
 */
export function validatePublish(
  params: RawHubParams,
  config: ResolvedConfig,
): PublishResult {
  const topic = params.url ?? params.topic;
  if (topic === null || topic === "") {
    return { ok: false, error: "url_required" };
  }
  if (!isHttpUrl(topic)) {
    return { ok: false, error: "url_not_url" };
  }
  if (!config.isAllowedTopic(topic)) {
    return { ok: false, error: "topic_not_supported" };
  }
  return { ok: true, mode: "publish", topic };
}
