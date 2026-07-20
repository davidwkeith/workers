/**
 * `@dwk/microsub` — the poll-queue consumer.
 *
 * The slow work the scheduled poller deferred runs here, off the request path,
 * with the queue providing retries and backoff. For each `poll` job it:
 *
 * 1. fetches the feed conditionally (sending the cached `ETag` /
 *    `Last-Modified`); a `304` is acked with nothing to do;
 * 2. parses the body to JF2 (Atom / RSS / JSON Feed / `h-feed`);
 * 3. appends new entries — deduped by entry id — to every channel following
 *    that feed, reaping past the per-channel retention ceiling; and
 * 4. records the returned validators for the next poll.
 *
 * A job whose fetch fails (unreachable / blocked / non-2xx) or whose store work
 * throws is retried; everything else is acked. Feeds are assumed newest-first,
 * so entries are inserted oldest-first and the newest gets the highest paging
 * `seq`. See `spec/packages/microsub.md`.
 *
 * @packageDocumentation
 */

import { hostFromUrl } from "@dwk/log";
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";

import {
  resolveConfig,
  type MicrosubConfig,
  type MicrosubEnv,
  type ResolvedConfig,
} from "./config.js";
import { fetchFeed } from "./discovery.js";
import { orderEntriesForInsert } from "./jf2.js";
import { MicrosubLogEvent } from "./log.js";
import type { MicrosubJob } from "./queue.js";
import { createMicrosubStore, type MicrosubStore } from "./store.js";

/** A Queue consumer for Microsub poll jobs. */
export type MicrosubQueueConsumer = (
  batch: MessageBatch<MicrosubJob>,
  env: MicrosubEnv,
  ctx: ExecutionContext,
) => Promise<void>;

/** Extra wiring for the consumer, primarily to inject a store/clock in tests. */
export interface ConsumerOptions {
  /** Override the store; defaults to a D1 store over `MICROSUB_DB`. */
  readonly store?: MicrosubStore;
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

function emit(
  config: ResolvedConfig,
  event: string,
  fields?: Record<string, unknown>,
): void {
  config.logger.info(event, fields);
  config.metrics.count(event, fields);
}

/**
 * Build the Queue consumer that polls feeds and appends to channel timelines.
 * Fails loudly if no store is configured (neither `options.store` nor the
 * `MICROSUB_DB` binding).
 */
export function createMicrosubQueueConsumer(
  config: MicrosubConfig,
  options?: ConsumerOptions,
): MicrosubQueueConsumer {
  const resolved = resolveConfig(config);
  const clock = options?.now ?? (() => Math.floor(Date.now() / 1000));

  return async (batch, env, _ctx) => {
    const store =
      options?.store ??
      (env.MICROSUB_DB
        ? createMicrosubStore(env)
        : (() => {
            throw new Error(
              "@dwk/microsub: missing required D1 binding `MICROSUB_DB`",
            );
          })());

    for (const message of batch.messages) {
      const job = message.body;
      try {
        const cache = await store.getFeedCache(job.feedUrl);
        const fetched = await fetchFeed(
          job.feedUrl,
          {
            fetch: resolved.fetch,
            logger: resolved.logger,
            metrics: resolved.metrics,
            fetchAllowedHosts: resolved.fetchAllowedHosts,
          },
          cache ?? undefined,
        );
        if (fetched === null) {
          // Unreachable / blocked / non-2xx — retry the whole job later.
          message.retry();
          continue;
        }

        const now = clock();

        let added = 0;
        if (!fetched.notModified && fetched.entries.length > 0) {
          // Order oldest-first so the newest entry gets the highest paging `seq`.
          const ordered = orderEntriesForInsert(fetched.entries);
          const channels = await store.channelsForFeed(job.feedUrl);
          for (const channel of channels) {
            added += await store.insertItems(
              channel,
              job.feedUrl,
              ordered,
              now,
              resolved.maxItemsPerChannel,
            );
          }
        }

        // Persist the conditional-fetch validators only AFTER the entries are
        // stored. If `insertItems` throws (→ `message.retry()`), the cache still
        // holds the OLD validators, so the retry re-fetches the entries instead
        // of getting a `304` for items it never stored (`insertItems` dedups by
        // entry id, so the re-insert is idempotent). On a `304` the response may
        // omit validators — keep the previously-cached ones rather than nulling
        // them, so the next poll stays conditional.
        await store.setFeedCache(
          job.feedUrl,
          fetched.etag ?? cache?.etag ?? null,
          fetched.lastModified ?? cache?.lastModified ?? null,
          now,
        );

        emit(resolved, MicrosubLogEvent.FeedPolled, {
          added,
          host: hostFromUrl(job.feedUrl),
        });
        message.ack();
      } catch (err) {
        emit(resolved, MicrosubLogEvent.PollRetry, {
          error: err instanceof Error ? err.name : "unknown",
          host: hostFromUrl(job.feedUrl),
        });
        message.retry();
      }
    }
  };
}
