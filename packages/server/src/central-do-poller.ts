/**
 * `DurableObjectAlarmPoller` — the per-replica jittered interval timer that
 * drives central-mode Durable Object alarms (spec/scale-out.md §6.3) and the
 * coordination KV's expired-row sweep.
 *
 * `@dwk/deno-host`'s `createDurableObjectNamespace` never starts a timer
 * itself — `ns.pollAlarms()` is a method the composing host wires to whatever
 * periodic trigger its runtime offers (spec/packages/deno-host.md). Unlike
 * `@dwk/cf-shims`' local-mode Durable Object shim (which auto-arms a
 * `setTimeout` per alarm from inside the shim), central mode's alarm schedule
 * is indexed in KV precisely so *any* replica's poll can find and claim a due
 * entry — so every replica MUST run this poller for alarms to fire at all.
 * Mirrors `@dwk/cf-shims`'s `CronScheduler` in shape (register once, `start`/
 * `stop`, overlapping-tick suppression, an unref'd timer), but ticks on a
 * fixed cadence plus jitter (so a fleet's replicas don't all poll in
 * lock-step) rather than a fixed interval per registered schedule, and polls
 * every registered namespace plus (optionally) sweeps the coordination KV's
 * expired rows on the same tick.
 *
 * @see spec/scale-out.md §6.3, §7.2 (issue #432)
 */

import { noopLogger, type Logger } from "@dwk/log";

/** The slice of `DurableObjectNamespaceLike` this poller drives. */
export interface PollableDurableObjectNamespace {
  pollAlarms(options?: {
    readonly now?: number;
    readonly batchSize?: number;
  }): Promise<void>;
}

/** The slice of `LibsqlKv` this poller sweeps, if given one. */
export interface SweepableCoordinationStore {
  sweepExpired(now?: number): Promise<number>;
}

export interface DurableObjectAlarmPollerOptions {
  /** The central-mode Durable Object namespaces this replica mounts. */
  readonly namespaces: readonly PollableDurableObjectNamespace[];
  /** The coordination store to sweep for expired rows on the same tick, if any. */
  readonly kv?: SweepableCoordinationStore;
  /** Base tick cadence in ms (default 1000, per spec/scale-out.md §6.3). */
  readonly intervalMs?: number;
  /** Random jitter added to each tick's delay, in ms (default 200). */
  readonly jitterMs?: number;
  readonly batchSize?: number;
  /** Clock source, for deterministic tests. */
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * Polls every registered namespace's `pollAlarms()` (and sweeps the
 * coordination KV, if given one) on a jittered interval. Overlapping ticks
 * are suppressed: a tick that runs long is not re-entered until it settles.
 * A single namespace's or the sweep's failure is logged and does not stop the
 * other namespaces in the same tick, nor future ticks.
 */
export class DurableObjectAlarmPoller {
  readonly #namespaces: readonly PollableDurableObjectNamespace[];
  readonly #kv?: SweepableCoordinationStore;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #batchSize?: number;
  readonly #now: () => number;
  readonly #logger: Logger;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = true;

  constructor(options: DurableObjectAlarmPollerOptions) {
    this.#namespaces = options.namespaces;
    this.#kv = options.kv;
    this.#intervalMs = options.intervalMs ?? 1000;
    this.#jitterMs = options.jitterMs ?? 200;
    this.#batchSize = options.batchSize;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? noopLogger;
  }

  /** Start ticking. A no-op if already started. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleNext();
  }

  /**
   * Stop ticking and wait for any in-flight tick to settle. Claimed-but-
   * unfinished alarm fires are not this poller's concern to drain — a claim
   * either completes or its lease's TTL frees the id for the next poller.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#running) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Run one tick immediately, ignoring the schedule. Exposed for tests. */
  async fireAll(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.#now();
      await Promise.all(
        this.#namespaces.map(async (ns) => {
          try {
            await ns.pollAlarms({ now, batchSize: this.#batchSize });
          } catch (err) {
            this.#logger.warn("central_do.poll_error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
      if (this.#kv !== undefined) {
        try {
          await this.#kv.sweepExpired(now);
        } catch (err) {
          this.#logger.warn("central_do.sweep_error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.#running = false;
    }
  }

  #scheduleNext(): void {
    const delay = this.#intervalMs + Math.floor(Math.random() * this.#jitterMs);
    this.#timer = setTimeout(() => void this.#tick(), delay);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    await this.fireAll();
    if (!this.#stopped) this.#scheduleNext();
  }
}
