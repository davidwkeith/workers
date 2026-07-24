/**
 * `CentralFleetPoller` — the per-replica jittered interval timer that drives
 * every central-mode background poll a replica must run for the fleet to be
 * operable: Durable Object alarms (spec/scale-out.md §6.3), the durable
 * queue broker's delivery pass (§7.1), and the coordination KV's expired-row
 * sweep.
 *
 * `@dwk/deno-host`'s `createDurableObjectNamespace` and `createQueueBroker`
 * never start a timer themselves — `ns.pollAlarms()` and
 * `broker.pollQueues()` are tick functions the composing host wires to
 * whatever periodic trigger its runtime offers (spec/packages/deno-host.md).
 * Unlike `@dwk/cf-shims`' local-mode shims (which auto-arm their own timers),
 * central mode's alarm/queue schedules are indexed in KV precisely so *any*
 * replica's poll can find and claim a due entry — so every replica MUST run
 * this poller for alarms or queued messages to be delivered at all. Mirrors
 * `@dwk/cf-shims`'s `CronScheduler` in shape (register once, `start`/`stop`,
 * overlapping-tick suppression, an unref'd timer), but ticks on a fixed
 * cadence plus jitter (so a fleet's replicas don't all poll in lock-step)
 * rather than a fixed interval per registered schedule, and polls every
 * registered namespace and queue broker plus (optionally) sweeps the
 * coordination KV's expired rows on the same tick — the "every replica
 * shares one background cadence" pairing spec/scale-out.md §7.1 describes.
 *
 * Named for the fleet-wide role it has grown into as of issue #433 — it
 * started as `DurableObjectAlarmPoller` (issue #432, alarms + sweep only)
 * and gained queue polling here rather than spawning a near-duplicate timer
 * class, since the whole point of sharing one tick is not running two. Cron
 * is deliberately NOT folded in here: a cron schedule's cadence is
 * per-handler and typically far longer than this poller's ~1s base tick, so
 * it keeps its own per-schedule timers (`CentralCronScheduler`,
 * `central-cron.ts`).
 *
 * @see spec/scale-out.md §6.3, §7.1, §7.2 (issues #432, #433)
 */

import { noopLogger, type Logger } from "@dwk/log";

/** The slice of `DurableObjectNamespaceLike` this poller drives. */
export interface PollableDurableObjectNamespace {
  pollAlarms(options?: {
    readonly now?: number;
    readonly batchSize?: number;
  }): Promise<void>;
}

/** The slice of `@dwk/deno-host`'s `QueueBroker` this poller drives. */
export interface PollableQueueBroker {
  pollQueues(options?: { readonly now?: number }): Promise<void>;
}

/** The slice of `LibsqlKv` this poller sweeps, if given one. */
export interface SweepableCoordinationStore {
  sweepExpired(now?: number): Promise<number>;
}

export interface CentralFleetPollerOptions {
  /** The central-mode Durable Object namespaces this replica mounts. */
  readonly namespaces?: readonly PollableDurableObjectNamespace[];
  /** The central-mode queue brokers this replica polls (spec §7.1, #433). */
  readonly queues?: readonly PollableQueueBroker[];
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
 * Polls every registered namespace's `pollAlarms()`, every registered queue
 * broker's `pollQueues()`, and sweeps the coordination KV (if given one) on a
 * jittered interval. Overlapping ticks are suppressed: a tick that runs long
 * is not re-entered until it settles. A single namespace's, broker's, or the
 * sweep's failure is logged and does not stop the others in the same tick,
 * nor future ticks.
 */
export class CentralFleetPoller {
  readonly #namespaces: readonly PollableDurableObjectNamespace[];
  readonly #queues: readonly PollableQueueBroker[];
  readonly #kv?: SweepableCoordinationStore;
  readonly #intervalMs: number;
  readonly #jitterMs: number;
  readonly #batchSize?: number;
  readonly #now: () => number;
  readonly #logger: Logger;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = true;

  constructor(options: CentralFleetPollerOptions = {}) {
    this.#namespaces = options.namespaces ?? [];
    this.#queues = options.queues ?? [];
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
   * unfinished alarm/message fires are not this poller's concern to drain —
   * each claim either completes or its own crash-safety backstop (the DO
   * lease's TTL; a queue message's own ack/retry-or-redeliver contract)
   * frees it for the next poller.
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
      await Promise.all([
        ...this.#namespaces.map(async (ns) => {
          try {
            await ns.pollAlarms({ now, batchSize: this.#batchSize });
          } catch (err) {
            this.#logger.warn("central_fleet.alarm_poll_error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
        ...this.#queues.map(async (broker) => {
          try {
            await broker.pollQueues({ now });
          } catch (err) {
            this.#logger.warn("central_fleet.queue_poll_error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      ]);
      if (this.#kv !== undefined) {
        try {
          const count = await this.#kv.sweepExpired(now);
          if (count > 0) {
            this.#logger.info("central_fleet.sweep_ok", { count });
          }
        } catch (err) {
          this.#logger.warn("central_fleet.sweep_error", {
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
