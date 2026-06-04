/**
 * `@dwk/websub` — the queue consumer.
 *
 * The hub's slow work runs here, off the request path, with the queue providing
 * retries and backoff. Two job kinds flow through:
 *
 * - **verify** — issue the verification-of-intent GET; on a confirmed subscribe,
 *   write the subscription to the D1 store with its lease expiry, and on a
 *   confirmed unsubscribe, remove it. A subscription row is created only after
 *   verification succeeds, so an unverified callback never lands in the store.
 * - **distribute** — prune expired leases, fetch the topic's current content, and
 *   fan it out (signed per-subscriber when a secret is set) to every active
 *   subscriber.
 *
 * A job whose store/fetch work throws — or a distribution that cannot fetch the
 * topic — is retried; everything else is acked. See `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

import { hostFromUrl, type LogFields } from "@dwk/log";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import {
  resolveConfig,
  type ResolvedConfig,
  type WebSubConfig,
  type WebSubEnv,
} from "./config";
import { deliverToSubscriber, fetchTopicContent } from "./distribute";
import { WebSubLogEvent } from "./log";
import type { WebSubJob } from "./queue";
import { createD1SubscriptionStore, type SubscriptionStore } from "./store";
import { verifyIntent } from "./verify";

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
          }
          message.ack();
          continue;
        }

        // kind === "distribute"
        const now = clock();
        await store.pruneExpired(now);
        const content = await fetchTopicContent(job.topic, {
          fetch: resolved.fetch,
          logger: resolved.logger,
          metrics: resolved.metrics,
        });
        if (content === null) {
          // The topic was unreachable / non-2xx — retry the whole job later
          // rather than dropping the push.
          message.retry();
          continue;
        }
        const subscribers = await store.listActive(job.topic, now);
        for (const subscriber of subscribers) {
          await deliverToSubscriber(subscriber, content, resolved.hubUrl, {
            fetch: resolved.fetch,
            logger: resolved.logger,
            metrics: resolved.metrics,
          });
        }
        message.ack();
      } catch (err) {
        // A store/queue failure must not retry silently — name the kind and
        // error so an operator can tell a transient blip from a wedged job.
        emit(resolved, "warn", WebSubLogEvent.QueueRetry, {
          kind: job.kind,
          error: err instanceof Error ? err.name : "unknown",
        });
        message.retry();
      }
    }
  };
}
