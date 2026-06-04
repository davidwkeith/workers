/**
 * `@dwk/websub` — queued job shapes.
 *
 * The hub does its slow, failure-prone work — the verification-of-intent GET and
 * content-distribution fan-out — off the request path, on a queue with retries
 * and backoff (`spec/packages/websub.md`). Two job kinds flow through the one
 * queue, discriminated by `kind`.
 *
 * @packageDocumentation
 */

/**
 * Verify a subscriber's intent: GET the callback with `hub.challenge` and,
 * on a confirming 2xx echo, activate (subscribe) or remove (unsubscribe) the
 * subscription. Carries everything needed to persist the subscription so the
 * store write happens only after verification succeeds.
 */
export interface VerifyJob {
  readonly kind: "verify";
  readonly mode: "subscribe" | "unsubscribe";
  readonly callback: string;
  readonly topic: string;
  /** Lease to grant on a confirmed subscribe (seconds); ignored for unsubscribe. */
  readonly leaseSeconds: number;
  /** Optional HMAC secret registered by the subscriber, stored on activation. */
  readonly secret?: string;
}

/**
 * Distribute a topic's current content to every active subscriber: fetch the
 * topic, then POST the body (signed per-subscriber when a secret is set) to each
 * verified callback.
 */
export interface DistributeJob {
  readonly kind: "distribute";
  readonly topic: string;
}

/** A job on the WebSub queue: either intent verification or content distribution. */
export type WebSubJob = VerifyJob | DistributeJob;
