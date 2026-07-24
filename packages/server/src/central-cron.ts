/**
 * `CentralCronScheduler` — the central-mode counterpart to `@dwk/cf-shims`'s
 * `CronScheduler`: every replica registers the same `scheduled` handlers on
 * the same cadence, but only one replica actually runs a given tick.
 *
 * Running an idempotent scheduled handler (the microsub poller, the R2 GC
 * cron) on every replica multiplies load for no benefit and — for the GC
 * cron specifically — widens its race window. Per
 * [spec/scale-out.md §7.2](../../../spec/scale-out.md#72-cron), each replica
 * still ticks on the schedule's own configured cadence (unlike
 * `CentralFleetPoller`'s shared ~1s base tick — a cron schedule's interval is
 * per-handler and typically far longer), but before running the handler it
 * first attempts a short-lived **tick lease** —
 * `["dwk_cron", name, tickBucket]`, set atomically with `expireIn` covering
 * the cadence, where `tickBucket` is the tick's scheduled time rounded down
 * to the cadence. Exactly one replica wins the CAS and runs the handler;
 * every other replica's claim for that bucket fails and it skips silently —
 * not an error, just how the fleet elects one runner per tick. A winner that
 * crashes mid-run is covered by handler idempotency plus the next tick
 * (host-contract §3.7 already permits missed-tick coalescing).
 *
 * Structurally compatible with `@dwk/cf-shims`'s `ScheduledHandler` (the same
 * `(controller) => Promise<void> | void` shape the local-mode `CronScheduler`
 * drives), so a package's `scheduled` handler — bound to `env`/`ctx` via
 * `bindScheduledTask` exactly as in local mode — runs unchanged under central
 * mode.
 *
 * @see spec/scale-out.md §7.2 (issue #433)
 */

import type { ScheduledController } from "@cloudflare/workers-types";
import { noopLogger, type Logger } from "@dwk/log";
import type { DenoKvLike } from "@dwk/deno-host";

/** A `scheduled` handler bound to its env/ctx by the host — same shape as `@dwk/cf-shims`'s. */
export type ScheduledHandler = (
  controller: ScheduledController,
) => Promise<void> | void;

interface Schedule {
  readonly name: string;
  readonly handler: ScheduledHandler;
  readonly intervalMs: number;
  readonly cron: string;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

export interface CentralCronSchedulerOptions {
  /** The coordination store backing the per-tick lease. */
  readonly kv: DenoKvLike;
  /** Clock source, for deterministic tests. */
  readonly now?: () => number;
  readonly logger?: Logger;
}

const CRON_PREFIX = "dwk_cron";

/**
 * Runs registered `scheduled` handlers on fixed per-schedule intervals, one
 * replica at a time per cadence bucket. Overlapping ticks are suppressed per
 * schedule, mirroring `@dwk/cf-shims`'s `CronScheduler`: a handler that runs
 * longer than its interval is not re-entered until it settles.
 */
export class CentralCronScheduler {
  readonly #kv: DenoKvLike;
  readonly #now: () => number;
  readonly #logger: Logger;
  readonly #schedules: Schedule[] = [];

  constructor(options: CentralCronSchedulerOptions) {
    this.#kv = options.kv;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? noopLogger;
  }

  /**
   * Register `handler` to run every `intervalMs`, one replica at a time.
   * `name` is the lease identity — it MUST be stable and unique per
   * schedule across the fleet (e.g. `"microsub-poll"`), since it is a
   * component of the tick-lease key every replica computes independently.
   * `cron` is an optional label (e.g. the deployment's cron expression)
   * surfaced on the controller.
   */
  register(
    name: string,
    handler: ScheduledHandler,
    intervalMs: number,
    cron = "",
  ): void {
    this.#schedules.push({
      name,
      handler,
      intervalMs,
      cron,
      timer: null,
      running: false,
    });
  }

  start(): void {
    for (const schedule of this.#schedules) {
      if (schedule.timer !== null) continue;
      schedule.timer = setInterval(
        () => void this.#fire(schedule),
        schedule.intervalMs,
      );
      schedule.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    for (const schedule of this.#schedules) {
      if (schedule.timer !== null) {
        clearInterval(schedule.timer);
        schedule.timer = null;
      }
    }
    while (this.#schedules.some((s) => s.running)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Fire every schedule once, immediately (still lease-guarded). Exposed for tests. */
  async fireAll(): Promise<void> {
    await Promise.all(this.#schedules.map((s) => this.#fire(s)));
  }

  async #fire(schedule: Schedule): Promise<void> {
    if (schedule.running) return;
    schedule.running = true;
    try {
      const now = this.#now();
      const tickBucket =
        Math.floor(now / schedule.intervalMs) * schedule.intervalMs;
      const key = [CRON_PREFIX, schedule.name, tickBucket];

      let won: boolean;
      try {
        const result = await this.#kv
          .atomic()
          .check({ key, versionstamp: null })
          .set(
            key,
            { holder: crypto.randomUUID() },
            { expireIn: schedule.intervalMs },
          )
          .commit();
        won = result.ok;
      } catch (err) {
        this.#logger.warn("central_cron.claim_error", {
          name: schedule.name,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (!won) {
        this.#logger.debug("central_cron.tick_lease_contended", {
          name: schedule.name,
          tickBucket,
        });
        return;
      }
      this.#logger.debug("central_cron.tick_lease_acquired", {
        name: schedule.name,
        tickBucket,
      });

      const controller = {
        scheduledTime: now,
        cron: schedule.cron,
        noRetry(): void {},
      } as unknown as ScheduledController;
      try {
        await schedule.handler(controller);
      } catch (err) {
        // A scheduled failure must not crash the host (host-contract §3.7);
        // the handler owns its own error reporting via its injected logger.
        this.#logger.warn("central_cron.handler_error", {
          name: schedule.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      schedule.running = false;
    }
  }
}
