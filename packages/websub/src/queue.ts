/**
 * `@dwk/websub` — queued job shapes.
 *
 * The hub does its slow, failure-prone work — the verification-of-intent GET and
 * content-distribution fan-out — off the request path, on a queue with retries
 * and backoff (`spec/packages/websub.md`). Three job kinds flow through the one
 * queue, discriminated by `kind`:
 *
 * - **verify** — one intent-verification GET.
 * - **distribute** — the fan-out *planner*: fetch the topic once, then enqueue
 *   one **deliver** job per active subscriber (so each subscriber retries on its
 *   own checkpoint instead of the whole topic re-delivering to everyone).
 * - **deliver** — one signed POST to one subscriber's callback, carrying the
 *   snapshot the planner fetched (inline for small bodies, or a reference to an
 *   R2-staged blob for bodies that exceed a queue message's size limit).
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
 * Plan a topic's fan-out: fetch the topic's current content once, then enqueue
 * one {@link DeliverJob} per active subscriber. Splitting the per-subscriber
 * POSTs into their own jobs gives each subscriber an independent retry
 * checkpoint (a callback down for ~30s no longer misses the update) and keeps a
 * large subscriber set from exceeding a single invocation's subrequest ceiling.
 */
export interface DistributeJob {
  readonly kind: "distribute";
  readonly topic: string;
}

/**
 * How a {@link DeliverJob} carries the snapshot the planner fetched:
 *
 * - **`inline`** — the body rides in the queue message itself, **base64-encoded**
 *   into `body`. A raw `Uint8Array` is *not* carried: Cloudflare Queues (and the
 *   Node self-host's queue shim) default to JSON-serializing a plain message
 *   object, which turns a byte array into `{"0":…,"1":…}` — ~10× larger and not a
 *   `Uint8Array` on the way back. A base64 string round-trips predictably and
 *   sizes at a known 4/3 of the raw body. Used when the body fits under
 *   {@link MAX_INLINE_BODY_BYTES} (chosen so the *encoded* message stays well
 *   inside a Cloudflare Queue message's ~128 KB limit).
 * - **`staged`** — the body was written once to the `WEBSUB_CONTENT` R2 bucket
 *   under `key`, and every per-subscriber job references it. Used when the body
 *   is too large to inline, so a viral feed with many subscribers stages the
 *   content a single time rather than copying it into every message.
 */
export type DeliverPayload =
  | { readonly via: "inline"; readonly body: string }
  | { readonly via: "staged"; readonly key: string };

/**
 * Deliver one topic snapshot to one subscriber: POST the body (signed with the
 * subscriber's `secret` when set) to `callback`. Carries everything a delivery
 * needs so the job is self-contained — the subscription store is not re-read on
 * the delivery path.
 */
export interface DeliverJob {
  readonly kind: "deliver";
  /** The subscriber's callback URL to POST to. */
  readonly callback: string;
  /** The topic being distributed (advertised in the `Link rel="self"` header). */
  readonly topic: string;
  /** The subscriber's HMAC secret, or `null` when the delivery is unsigned. */
  readonly secret: string | null;
  /** The snapshot's `Content-Type`, forwarded verbatim (WebSub §7). */
  readonly contentType: string;
  /** Where the body lives: inline in this message, or staged in R2. */
  readonly payload: DeliverPayload;
}

/**
 * A job on the WebSub queue: intent verification, a distribution *plan*, or one
 * per-subscriber delivery.
 */
export type WebSubJob = VerifyJob | DistributeJob | DeliverJob;
