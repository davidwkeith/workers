/**
 * `@dwk/websub` — the queue consumer.
 *
 * The hub's slow work runs here, off the request path, with the queue providing
 * retries and backoff. Three job kinds flow through:
 *
 * - **verify** — issue the verification-of-intent GET; on a confirmed subscribe,
 *   write the subscription to the D1 store with its lease expiry, and on a
 *   confirmed unsubscribe, remove it. A subscription row is created only after
 *   verification succeeds, so an unverified callback never lands in the store.
 * - **distribute** — the fan-out *planner*: prune expired leases, fetch the
 *   topic's current content **once**, then enqueue one **deliver** job per active
 *   subscriber (inlining the snapshot, or staging it in R2 when it is too large
 *   to inline).
 * - **deliver** — POST the snapshot to one subscriber's callback (signed when a
 *   secret is set). A failed POST retries on this subscriber's own queue
 *   checkpoint, so a callback down for a while no longer misses the update, and a
 *   store-throw no longer re-delivers to every subscriber.
 *
 * A job whose store/fetch work throws — or a distribution that cannot fetch the
 * topic, or a single delivery that could not be POSTed — is retried; everything
 * else is acked. See `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

import { hostFromUrl, type LogFields } from "@dwk/log";
import type {
  ExecutionContext,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types";
import {
  resolveConfig,
  type ResolvedConfig,
  type WebSubConfig,
  type WebSubEnv,
} from "./config.js";
import {
  deliverToSubscriber,
  decodeInlineBody,
  encodeInlineBody,
  fetchTopicContent,
  readStagedContent,
  stageContent,
  MAX_INLINE_BODY_BYTES,
  type TopicContent,
} from "./distribute.js";
import { WebSubLogEvent } from "./log.js";
import type { DeliverJob, DeliverPayload, WebSubJob } from "./queue.js";
import {
  createD1SubscriptionStore,
  type Subscription,
  type SubscriptionStore,
} from "./store.js";
import { notifyDenial, verifyIntent } from "./verify.js";

/**
 * Cloudflare Queue `sendBatch` accepts at most 100 messages per call and ~256 KB
 * total; batch the per-subscriber deliver jobs by both bounds so a large
 * subscriber set is enqueued in a handful of subrequests rather than one
 * `send()` per subscriber (which would itself blow the subrequest ceiling).
 */
const MAX_SEND_BATCH = 100;
const MAX_SEND_BATCH_BYTES = 240 * 1024;

/** Base delay (seconds) before the first queue retry, doubled per attempt. */
const RETRY_BASE_DELAY_SECONDS = 30;
/** Ceiling on the retry delay (seconds), regardless of attempt count. */
const RETRY_MAX_DELAY_SECONDS = 3600;

/**
 * Exponential backoff (base {@link RETRY_BASE_DELAY_SECONDS}, doubling per
 * attempt, capped at {@link RETRY_MAX_DELAY_SECONDS}) for a queue message's
 * `retry({ delaySeconds })`. A bare `message.retry()` with no delay would
 * re-deliver against an unreachable callback/topic at the queue's default
 * cadence indefinitely, hammering it instead of backing off.
 */
function retryDelaySeconds(attempts: number): number {
  // Defensively clamp to a valid attempt count: real Cloudflare Queue
  // messages always report attempts >= 1, but a test double or a future
  // platform change reporting 0/undefined/NaN must not compute a NaN delay.
  const safeAttempts =
    Number.isFinite(attempts) && attempts >= 1 ? attempts : 1;
  return Math.min(
    RETRY_BASE_DELAY_SECONDS * 2 ** (safeAttempts - 1),
    RETRY_MAX_DELAY_SECONDS,
  );
}

/** Rough serialized size of one deliver job, for byte-budgeting a send batch. */
function estimateJobBytes(job: DeliverJob): number {
  const base =
    job.callback.length +
    job.topic.length +
    (job.secret?.length ?? 0) +
    job.contentType.length +
    64;
  return job.payload.via === "inline"
    ? base + job.payload.body.length
    : base + job.payload.key.length;
}

/**
 * Enqueue `jobs` via `sendBatch`, chunked to stay within the queue's limits.
 *
 * If a later chunk throws after earlier chunks already flushed, the error
 * propagates and the whole `distribute` job retries, which re-enqueues deliver
 * jobs for the already-flushed subscribers too. That is a bounded, WebSub-legal
 * duplication (§7 requires subscribers to tolerate duplicate deliveries) chosen
 * over the alternative — swallowing the failure would silently *drop* the
 * unflushed subscribers' update, a far worse outcome than an extra POST.
 */
async function sendDeliverJobs(
  queue: Queue<WebSubJob>,
  jobs: readonly DeliverJob[],
): Promise<void> {
  let batch: { body: DeliverJob }[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length > 0) {
      await queue.sendBatch(batch);
      batch = [];
      bytes = 0;
    }
  };
  for (const job of jobs) {
    const size = estimateJobBytes(job);
    if (
      batch.length >= MAX_SEND_BATCH ||
      (batch.length > 0 && bytes + size > MAX_SEND_BATCH_BYTES)
    ) {
      await flush();
    }
    batch.push({ body: job });
    bytes += size;
  }
  await flush();
}

/** Build one per-subscriber deliver job from a subscription and a payload. */
function deliverJobFor(
  subscriber: Subscription,
  contentType: string,
  payload: DeliverPayload,
): DeliverJob {
  return {
    kind: "deliver",
    callback: subscriber.callback,
    topic: subscriber.topic,
    secret: subscriber.secret,
    contentType,
    payload,
  };
}

/** A Queue consumer for WebSub verification and distribution jobs. */
export type WebSubQueueConsumer = (
  batch: MessageBatch<WebSubJob>,
  env: WebSubEnv,
  ctx: ExecutionContext,
) => Promise<void>;

/** Extra wiring for the consumer, primarily to inject a store in tests. */
export interface ConsumerOptions {
  /** Override the subscription store; defaults to a D1 store over `WEBSUB_DB`. */
  readonly store?: SubscriptionStore;
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

function resolveStore(
  options: ConsumerOptions | undefined,
  env: WebSubEnv,
): SubscriptionStore {
  if (options?.store !== undefined) {
    return options.store;
  }
  if (env.WEBSUB_DB === undefined) {
    throw new Error("@dwk/websub: missing required binding WEBSUB_DB.");
  }
  return createD1SubscriptionStore(env.WEBSUB_DB);
}

function requireQueue(env: WebSubEnv): Queue<WebSubJob> {
  if (env.WEBSUB_QUEUE === undefined) {
    throw new Error("@dwk/websub: missing required binding WEBSUB_QUEUE.");
  }
  return env.WEBSUB_QUEUE;
}

/**
 * Plan a distribution: choose an inline vs. R2-staged payload for the snapshot,
 * then enqueue one deliver job per subscriber. Throws (so the distribute job
 * retries and an operator is alerted) if the snapshot is too large to inline and
 * no `WEBSUB_CONTENT` bucket is configured to stage it — the push is never
 * silently dropped or truncated.
 */
async function planDistribution(
  resolved: ResolvedConfig,
  env: WebSubEnv,
  queue: Queue<WebSubJob>,
  content: TopicContent,
  subscribers: readonly Subscription[],
): Promise<void> {
  let payload: DeliverPayload;
  let staged: boolean;
  if (content.body.byteLength <= MAX_INLINE_BODY_BYTES) {
    payload = { via: "inline", body: encodeInlineBody(content.body) };
    staged = false;
  } else if (env.WEBSUB_CONTENT === undefined) {
    throw new Error(
      "@dwk/websub: distribution snapshot exceeds the inline queue limit and " +
        "the WEBSUB_CONTENT R2 binding is not configured for staging.",
    );
  } else {
    payload = {
      via: "staged",
      key: await stageContent(env.WEBSUB_CONTENT, content.body),
    };
    staged = true;
  }

  const jobs = subscribers.map((subscriber) =>
    deliverJobFor(subscriber, content.contentType, payload),
  );
  await sendDeliverJobs(queue, jobs);
  emit(resolved, "info", WebSubLogEvent.DeliveryScheduled, {
    topicHost: hostFromUrl(subscribers[0]?.topic ?? ""),
    subscriberCount: subscribers.length,
    staged,
  });
}

/**
 * Perform one per-subscriber delivery. Resolves the body (inline, or read back
 * from R2 for a staged snapshot) and POSTs it. Returns `"retry"` when the POST
 * failed (the subscriber gets an independent, queue-backed retry) or `"ack"`
 * when it succeeded or the delivery is unrecoverable (its staged snapshot was
 * already reclaimed). A transient R2 read error throws and is retried by the
 * caller's catch.
 */
async function runDelivery(
  resolved: ResolvedConfig,
  env: WebSubEnv,
  job: DeliverJob,
): Promise<"ack" | "retry"> {
  let body: Uint8Array;
  if (job.payload.via === "inline") {
    body = decodeInlineBody(job.payload.body);
  } else {
    if (env.WEBSUB_CONTENT === undefined) {
      // A staged delivery landed with no bucket to read it from: a
      // misconfiguration. Throw so it retries and an operator is alerted rather
      // than silently dropping the push.
      throw new Error(
        "@dwk/websub: a staged delivery requires the WEBSUB_CONTENT R2 binding.",
      );
    }
    const staged = await readStagedContent(env.WEBSUB_CONTENT, job.payload.key);
    if (staged === null) {
      // The snapshot was reclaimed before this delivery ran (lifecycle expiry).
      // Retrying can't bring it back, so drop this one delivery.
      emit(resolved, "warn", WebSubLogEvent.StagedContentMissing, {
        callbackHost: hostFromUrl(job.callback),
      });
      return "ack";
    }
    body = staged;
  }

  const result = await deliverToSubscriber(
    { callback: job.callback, topic: job.topic, secret: job.secret },
    { body, contentType: job.contentType },
    resolved.hubUrl,
    {
      fetch: resolved.fetch,
      logger: resolved.logger,
      metrics: resolved.metrics,
      signatureAlgorithm: resolved.signatureAlgorithm,
      fetchAllowedHosts: resolved.fetchAllowedHosts,
    },
  );
  return result.delivered ? "ack" : "retry";
}

/**
 * Build the Queue consumer that performs intent verification and content
 * distribution. Fails loudly if no store is configured (neither
 * `options.store` nor the `WEBSUB_DB` binding).
 */
export function createWebSubQueueConsumer(
  config: WebSubConfig,
  options?: ConsumerOptions,
): WebSubQueueConsumer {
  const resolved = resolveConfig(config);
  const clock = options?.now ?? (() => Date.now());

  return async (batch, env, _ctx) => {
    const store = resolveStore(options, env);

    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (job.kind === "verify") {
          const result = await verifyIntent(job.callback, job.topic, {
            mode: job.mode,
            leaseSeconds:
              job.mode === "subscribe" ? job.leaseSeconds : undefined,
            fetch: resolved.fetch,
            logger: resolved.logger,
            metrics: resolved.metrics,
            fetchAllowedHosts: resolved.fetchAllowedHosts,
          });
          if (result.confirmed) {
            if (job.mode === "subscribe") {
              await store.upsert({
                callback: job.callback,
                topic: job.topic,
                secret: job.secret,
                leaseSeconds: job.leaseSeconds,
                now: clock(),
              });
              emit(resolved, "info", WebSubLogEvent.SubscriptionActivated, {
                callbackHost: hostFromUrl(job.callback),
                topicHost: hostFromUrl(job.topic),
                leaseSeconds: job.leaseSeconds,
              });
            } else {
              await store.remove(job.callback, job.topic);
              emit(resolved, "info", WebSubLogEvent.SubscriptionRemoved, {
                callbackHost: hostFromUrl(job.callback),
                topicHost: hostFromUrl(job.topic),
                reason: "unsubscribed",
              });
            }
          } else if (job.mode === "subscribe") {
            // Intent unconfirmed: signal denial to the subscriber (WebSub §5.2)
            // instead of silently dropping the request. (An unconfirmed
            // unsubscribe simply leaves the existing subscription in place.)
            await notifyDenial(job.callback, job.topic, {
              reason: "verification_failed",
              fetch: resolved.fetch,
              logger: resolved.logger,
              metrics: resolved.metrics,
              fetchAllowedHosts: resolved.fetchAllowedHosts,
            });
          }
          message.ack();
          continue;
        }

        if (job.kind === "deliver") {
          const delivered = await runDelivery(resolved, env, job);
          if (delivered === "retry") {
            message.retry({
              delaySeconds: retryDelaySeconds(message.attempts),
            });
          } else {
            message.ack();
          }
          continue;
        }

        // kind === "distribute" — the fan-out planner.
        const now = clock();
        await store.pruneExpired(now);
        const fetched = await fetchTopicContent(job.topic, {
          fetch: resolved.fetch,
          logger: resolved.logger,
          metrics: resolved.metrics,
          defaultContentType: resolved.defaultContentType,
          fetchAllowedHosts: resolved.fetchAllowedHosts,
        });
        if (fetched.kind === "retry") {
          // The topic was unreachable / non-2xx — retry the whole job later
          // rather than dropping the push.
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
          continue;
        }
        if (fetched.kind === "drop") {
          // A permanent, deterministic refusal (e.g. an unlabelable topic):
          // retrying can't fix it, so ack and move on rather than clog the
          // queue and re-hammer the topic. fetchTopicContent already logged why.
          message.ack();
          continue;
        }
        const subscribers = await store.listActive(job.topic, now);
        if (subscribers.length === 0) {
          // Nobody to deliver to (all leases pruned/expired): nothing to fan out.
          message.ack();
          continue;
        }
        // Enqueue one deliver job per subscriber. Each retries on its own queue
        // checkpoint, so a callback down for a while no longer misses the update
        // and a large subscriber set no longer blows one invocation's subrequest
        // ceiling or re-delivers to everyone on a single failure.
        await planDistribution(
          resolved,
          env,
          requireQueue(env),
          fetched.content,
          subscribers,
        );
        message.ack();
      } catch (err) {
        // A store/queue failure must not retry silently — name the kind and
        // error so an operator can tell a transient blip from a wedged job.
        emit(resolved, "warn", WebSubLogEvent.QueueRetry, {
          kind: job.kind,
          error: err instanceof Error ? err.name : "unknown",
        });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  };
}
