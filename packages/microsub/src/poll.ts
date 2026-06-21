/**
 * `@dwk/microsub` — the scheduled poller.
 *
 * A Cron Trigger drives {@link createMicrosubPoller}: on each run it lists every
 * distinct followed feed and enqueues one poll job per feed onto
 * `MICROSUB_QUEUE`, so the slow fetch-and-parse work happens off this path, on
 * the queue, with retries and backoff (see {@link ./consumer}). Polling never
 * runs inline on the Microsub read path — the read path serves stored entries
 * only (`spec/packages/microsub.md`).
 *
 * @packageDocumentation
 */

import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";

import {
  resolveConfig,
  type MicrosubConfig,
  type MicrosubEnv,
  type ResolvedConfig,
} from "./config.js";
import { MicrosubLogEvent } from "./log.js";
import { createMicrosubStore } from "./store.js";

/** A `scheduled`-compatible Worker handler. */
export type MicrosubScheduledHandler = (
  controller: ScheduledController,
  env: MicrosubEnv,
  ctx: ExecutionContext,
) => Promise<void>;

function emit(
  config: ResolvedConfig,
  event: string,
  fields?: Record<string, unknown>,
): void {
  config.logger.info(event, fields);
  config.metrics.count(event, fields);
}

/**
 * Build the scheduled poller. Fails loudly if `MICROSUB_DB` or `MICROSUB_QUEUE`
 * is missing — no silent degradation (composition contract).
 */
export function createMicrosubPoller(
  config: MicrosubConfig,
): MicrosubScheduledHandler {
  const resolved = resolveConfig(config);
  return async (_controller, env, _ctx) => {
    if (!env.MICROSUB_DB) {
      throw new Error(
        "@dwk/microsub: missing required D1 binding `MICROSUB_DB`",
      );
    }
    if (!env.MICROSUB_QUEUE) {
      throw new Error(
        "@dwk/microsub: missing required binding `MICROSUB_QUEUE`",
      );
    }
    const store = createMicrosubStore(env);
    const feeds = await store.distinctFeedUrls();
    await Promise.all(
      feeds.map((feedUrl) =>
        env.MICROSUB_QUEUE.send({ kind: "poll", feedUrl }),
      ),
    );
    emit(resolved, MicrosubLogEvent.PollScheduled, { feeds: feeds.length });
  };
}
