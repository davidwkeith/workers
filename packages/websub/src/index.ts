/**
 * `@dwk/websub` — WebSub (W3C) hub.
 *
 * Endpoint package. The publish-side, real-time complement to `@dwk/webmention`:
 * subscribers receive a push when the user's feed changes instead of polling. The
 * hub fields `hub.mode=subscribe|unsubscribe` requests (validated synchronously,
 * verified-of-intent and persisted asynchronously) and publish pings, keeps a
 * strongly-consistent D1 subscription store with lease expiry, and on publish
 * fans the topic's content out to every verified callback — signing the body with
 * HMAC-SHA256 (`X-Hub-Signature`) when the subscriber registered a secret. The
 * feeds themselves are static SSG artifacts (Anglesite's job, including the
 * `Link rel="hub"`/`rel="self"` advertisement); this package is only the dynamic
 * layer. Cloudflare specifics (D1, Queue) are confined here; validation, lease
 * math, verification, and signing are pure and unit-test without a Workers
 * runtime. See `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

export {
  createWebSub,
  createPublishNotifier,
  type WebSubHandler,
  type PublishNotifier,
} from "./handler";
export {
  createWebSubQueueConsumer,
  type WebSubQueueConsumer,
  type ConsumerOptions,
} from "./consumer";
export {
  resolveConfig,
  normalizeTopic,
  clampLease,
  DEFAULT_MIN_LEASE_SECONDS,
  DEFAULT_MAX_LEASE_SECONDS,
  type WebSubConfig,
  type WebSubEnv,
  type ResolvedConfig,
} from "./config";
export {
  createD1SubscriptionStore,
  type SubscriptionStore,
  type Subscription,
  type SubscriptionUpsert,
  type D1StoreOptions,
} from "./store";
export {
  validateSubscribe,
  validatePublish,
  readHubParams,
  MAX_SECRET_BYTES,
  type SubscribeResult,
  type SubscribeRequest,
  type SubscribeError,
  type PublishResult,
  type PublishRequest,
  type PublishError,
  type RawHubParams,
} from "./validate";
export {
  verifyIntent,
  buildVerificationUrl,
  generateChallenge,
  notifyDenial,
  buildDenialUrl,
  type VerifyIntentOptions,
  type VerifyIntentResult,
  type NotifyDenialOptions,
} from "./verify";
export {
  contentSignature,
  buildLinkHeader,
  fetchTopicContent,
  deliverToSubscriber,
  DEFAULT_SIGNATURE_ALGORITHM,
  type SignatureAlgorithm,
  type TopicContent,
  type TopicFetchResult,
  type DeliveryResult,
  type DistributeOptions,
} from "./distribute";
export type { WebSubJob, VerifyJob, DistributeJob } from "./queue";
export type { FetchLike } from "./fetch";
export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SsrfReason,
} from "./safe-fetch";
export { WebSubLogEvent } from "./log";
export type { Logger, Metrics } from "@dwk/log";
