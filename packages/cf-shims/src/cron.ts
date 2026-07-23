/**
 * Cron / `scheduled` timer shim.
 *
 * On Cloudflare a `scheduled` handler is fired by the platform on a cron
 * cadence. On Node the host runs each registered handler on a timer, passing a
 * `ScheduledController`-shaped argument. The cadence is expressed in
 * milliseconds (the host config maps a deployment's cron to an interval), which
 * keeps the shim dependency-free — no cron-expression parser is pulled in.
 *
 * Drives the `microsub` poller and the `solid-pod` / `remotestorage` R2 GC cron.
 *
 * @see spec/self-hosting.md §7.5
 */

import type { ScheduledController } from "@cloudflare/workers-types";

/** A `scheduled` handler bound to its env/ctx by the host. */
export type ScheduledHandler = (
  controller: ScheduledController,
) => Promise<void> | void;

interface Schedule {
  readonly handler: ScheduledHandler;
  readonly intervalMs: number;
  /** The original cron expression, surfaced on the controller for parity. */
  readonly cron: string;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

/** Options for {@link CronScheduler}. */
export interface CronSchedulerOptions {
  /** Clock source, for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Runs registered `scheduled` handlers on fixed intervals. Overlapping ticks are
 * suppressed per schedule: a handler that runs longer than its interval will not
 * be re-entered until it settles.
 */
export class CronScheduler {
  readonly #now: () => number;
  readonly #schedules: Schedule[] = [];

  constructor(options: CronSchedulerOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Register `handler` to run every `intervalMs`. `cron` is an optional label
   * (e.g. the deployment's cron expression) surfaced on the controller.
   */
  register(handler: ScheduledHandler, intervalMs: number, cron = ""): void {
    this.#schedules.push({
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
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Fire every schedule once, immediately. Exposed for deterministic tests. */
  async fireAll(): Promise<void> {
    await Promise.all(this.#schedules.map((s) => this.#fire(s)));
  }

  async #fire(schedule: Schedule): Promise<void> {
    if (schedule.running) return;
    schedule.running = true;
    const controller = {
      scheduledTime: this.#now(),
      cron: schedule.cron,
      noRetry(): void {},
    } as unknown as ScheduledController;
    try {
      await schedule.handler(controller);
    } catch {
      // A scheduled failure must not crash the host; the handler owns its
      // error reporting (via its injected logger).
    } finally {
      schedule.running = false;
    }
  }
}
