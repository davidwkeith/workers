/**
 * Lifecycle binding: adapt Cloudflare-shaped queue/scheduled handlers onto the
 * host's {@link ./shims/queue.QueueBroker} and {@link ./shims/cron.CronScheduler}.
 *
 * The endpoint packages export their async work as the same handlers a
 * Cloudflare Worker exposes: a queue consumer is `(batch, env, ctx)` and a
 * `scheduled` handler is `(controller, env, ctx)`. The host's in-process broker
 * and scheduler, by contrast, invoke registrations with just the batch /
 * controller — they are env-agnostic, like the runtime. These adapters close
 * the gap exactly as `server.ts` binds env + an `ExecutionContext` to a fetch
 * handler at dispatch: they bind the assembled `Env` and a fresh,
 * waitUntil-tracked `ExecutionContext`, so the package handlers run unchanged
 * and any background work they schedule is drained on shutdown.
 *
 * @see spec/self-hosting.md §7.5
 */

import type {
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import { HostExecutionContext, type WaitUntilTracker } from "./context";
import type { QueueConsumerHandler } from "./shims/queue";
import type { ScheduledHandler } from "./shims/cron";

/**
 * A Cloudflare-shaped queue consumer. `env` is typed `never` so a consumer
 * written against any concrete `Env` fragment (e.g. `WebmentionEnv`) is
 * assignable here by contravariance; the host passes the assembled `Env` at
 * call time.
 */
export type QueueHandler<T = unknown> = (
  batch: MessageBatch<T>,
  env: never,
  ctx: ExecutionContext,
) => Promise<void>;

/** A Cloudflare-shaped `scheduled` handler, with the same `never` env trick. */
export type ScheduledTaskHandler = (
  controller: ScheduledController,
  env: never,
  ctx: ExecutionContext,
) => Promise<void>;

/**
 * Bind a queue consumer's `env` and a fresh waitUntil-tracked `ExecutionContext`
 * so it can be registered with {@link ./shims/queue.QueueBroker.consumer}. Pass
 * the same {@link WaitUntilTracker} you hand to `createServer` (via
 * `HostConfig.tracker`) so background work the consumer schedules is drained on
 * shutdown.
 */
export function bindQueueConsumer<T>(
  handler: QueueHandler<T>,
  env: Readonly<Record<string, unknown>>,
  tracker: WaitUntilTracker,
): QueueConsumerHandler<T> {
  return (batch) =>
    handler(batch, env as never, new HostExecutionContext(tracker));
}

/**
 * Bind a `scheduled` handler's `env` and a fresh waitUntil-tracked
 * `ExecutionContext` so it can be registered with
 * {@link ./shims/cron.CronScheduler.register}. Powers the `microsub` poller and
 * the R2 GC cron.
 */
export function bindScheduledTask(
  handler: ScheduledTaskHandler,
  env: Readonly<Record<string, unknown>>,
  tracker: WaitUntilTracker,
): ScheduledHandler {
  return (controller) =>
    handler(controller, env as never, new HostExecutionContext(tracker));
}
