/**
 * In-process Queue shim: producers + a consumer runner.
 *
 * The async packages export both producers (a `Queue` binding) and consumers
 * (`createWebmentionQueueConsumer`, `createMicrosubQueueConsumer`, the WebSub
 * consumer). This broker provides the `send`/`sendBatch` producer surface and a
 * worker loop that delivers batches to a registered consumer with the same
 * `MessageBatch` shape — including `ack()`/`retry()`/`ackAll()`/`retryAll()`
 * semantics, a visibility lease, exponential backoff, and a dead-letter cap.
 *
 * It is **SQLite-backed and durable by default** so jobs survive a reboot
 * (at-least-once across crashes, matching the contract the consumers assume); an
 * in-memory mode is available for dev/tests.
 *
 * @see spec/self-hosting.md §7.5
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Queue,
  MessageBatch,
  Message,
  MessageSendRequest,
} from "@cloudflare/workers-types";

/** A claimed job, leased to the current delivery attempt. */
interface JobRow {
  readonly id: number;
  readonly body: string;
  readonly attempts: number;
}

/** Backing store for jobs; abstracts SQLite (durable) vs `Map` (in-memory). */
interface JobStore {
  enqueue(queue: string, body: string, visibleAt: number): void;
  /** Atomically claim due jobs and lease them until `leaseUntil`. */
  claim(
    queue: string,
    now: number,
    limit: number,
    leaseUntil: number,
  ): JobRow[];
  ack(id: number): void;
  /** Re-schedule a job (or mark it dead if it has exhausted its retries). */
  reschedule(
    id: number,
    attempts: number,
    visibleAt: number,
    dead: boolean,
  ): void;
  pending(queue: string): number;
}

class MemoryJobStore implements JobStore {
  #seq = 0;
  readonly #jobs = new Map<
    number,
    {
      queue: string;
      body: string;
      attempts: number;
      visibleAt: number;
      dead: boolean;
    }
  >();

  enqueue(queue: string, body: string, visibleAt: number): void {
    this.#jobs.set(++this.#seq, {
      queue,
      body,
      attempts: 0,
      visibleAt,
      dead: false,
    });
  }
  claim(
    queue: string,
    now: number,
    limit: number,
    leaseUntil: number,
  ): JobRow[] {
    const out: JobRow[] = [];
    for (const [id, job] of this.#jobs) {
      if (out.length >= limit) break;
      if (job.queue === queue && !job.dead && job.visibleAt <= now) {
        job.visibleAt = leaseUntil;
        out.push({ id, body: job.body, attempts: job.attempts });
      }
    }
    return out;
  }
  ack(id: number): void {
    this.#jobs.delete(id);
  }
  reschedule(
    id: number,
    attempts: number,
    visibleAt: number,
    dead: boolean,
  ): void {
    const job = this.#jobs.get(id);
    if (job) Object.assign(job, { attempts, visibleAt, dead });
  }
  pending(queue: string): number {
    let n = 0;
    for (const job of this.#jobs.values()) {
      if (job.queue === queue && !job.dead) n++;
    }
    return n;
  }
}

class SqliteJobStore implements JobStore {
  readonly #db: DatabaseSync;
  readonly #enqueue: StatementSync;
  readonly #due: StatementSync;
  readonly #lease: StatementSync;
  readonly #ack: StatementSync;
  readonly #reschedule: StatementSync;
  readonly #pending: StatementSync;

  constructor(location: string) {
    if (location !== ":memory:")
      mkdirSync(dirname(location), { recursive: true });
    this.#db = new DatabaseSync(location);
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS queue_jobs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         queue TEXT NOT NULL,
         body TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         visible_at INTEGER NOT NULL,
         dead INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX IF NOT EXISTS idx_queue_jobs_poll
         ON queue_jobs (queue, dead, visible_at);`,
    );
    this.#enqueue = this.#db.prepare(
      "INSERT INTO queue_jobs (queue, body, visible_at) VALUES (?, ?, ?)",
    );
    this.#due = this.#db.prepare(
      `SELECT id, body, attempts FROM queue_jobs
         WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY id LIMIT ?`,
    );
    this.#lease = this.#db.prepare(
      "UPDATE queue_jobs SET visible_at = ? WHERE id = ?",
    );
    this.#ack = this.#db.prepare("DELETE FROM queue_jobs WHERE id = ?");
    this.#reschedule = this.#db.prepare(
      "UPDATE queue_jobs SET attempts = ?, visible_at = ?, dead = ? WHERE id = ?",
    );
    this.#pending = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM queue_jobs WHERE queue = ? AND dead = 0",
    );
  }

  enqueue(queue: string, body: string, visibleAt: number): void {
    this.#enqueue.run(queue, body, visibleAt);
  }
  claim(
    queue: string,
    now: number,
    limit: number,
    leaseUntil: number,
  ): JobRow[] {
    this.#db.exec("BEGIN");
    try {
      const rows = this.#due.all(queue, now, limit) as unknown as JobRow[];
      for (const row of rows) this.#lease.run(leaseUntil, row.id);
      this.#db.exec("COMMIT");
      return rows;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
  ack(id: number): void {
    this.#ack.run(id);
  }
  reschedule(
    id: number,
    attempts: number,
    visibleAt: number,
    dead: boolean,
  ): void {
    this.#reschedule.run(attempts, visibleAt, dead ? 1 : 0, id);
  }
  pending(queue: string): number {
    return Number((this.#pending.get(queue) as { n: number }).n);
  }
}

/** Per-consumer delivery tuning. */
export interface ConsumerOptions {
  /** Maximum messages delivered in one batch (default 10). */
  readonly maxBatchSize?: number;
  /** Attempts before a message is dead-lettered (default 5). */
  readonly maxRetries?: number;
  /** Base backoff in ms; doubles per attempt (default 1000). */
  readonly baseRetryDelayMs?: number;
  /** How long a claimed batch is hidden before redelivery (default 30000). */
  readonly visibilityTimeoutMs?: number;
}

/** A consumer that receives a fully-formed {@link MessageBatch}. */
export type QueueConsumerHandler<T> = (batch: MessageBatch<T>) => Promise<void>;

interface Registration {
  readonly handler: QueueConsumerHandler<unknown>;
  readonly options: Required<ConsumerOptions>;
}

const DEFAULT_OPTIONS: Required<ConsumerOptions> = {
  maxBatchSize: 10,
  maxRetries: 5,
  baseRetryDelayMs: 1000,
  visibilityTimeoutMs: 30000,
};

/** Options for {@link QueueBroker}. */
export interface QueueBrokerOptions {
  /** SQLite file for durable jobs; omit for an in-memory queue (dev/tests). */
  readonly location?: string;
  /** How often the worker loop wakes to deliver due jobs (default 1000ms). */
  readonly pollIntervalMs?: number;
  /** Clock source, for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Manages the named queues for a host: hands out producer bindings, registers
 * consumers, and runs the delivery loop. The server starts/stops it as part of
 * the lifecycle.
 */
export class QueueBroker {
  readonly #store: JobStore;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #consumers = new Map<string, Registration>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  constructor(options: QueueBrokerOptions = {}) {
    this.#store =
      options.location && options.location !== ":memory:"
        ? new SqliteJobStore(options.location)
        : new MemoryJobStore();
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /** A {@link Queue} producer binding for `name`. */
  producer<T = unknown>(name: string): Queue<T> {
    const store = this.#store;
    const now = this.#now;
    const queue = {
      async send(
        message: T,
        options?: { delaySeconds?: number },
      ): Promise<void> {
        store.enqueue(name, JSON.stringify(message), now() + delayMs(options));
      },
      async sendBatch(
        messages: Iterable<MessageSendRequest<T>>,
        options?: { delaySeconds?: number },
      ): Promise<void> {
        for (const req of messages) {
          const at =
            now() +
            delayMs({ delaySeconds: req.delaySeconds }) +
            delayMs(options);
          store.enqueue(name, JSON.stringify(req.body), at);
        }
      },
    };
    return queue as unknown as Queue<T>;
  }

  /** Register the consumer for `name`; only one consumer per queue. */
  consumer<T>(
    name: string,
    handler: QueueConsumerHandler<T>,
    options: ConsumerOptions = {},
  ): void {
    this.#consumers.set(name, {
      handler: handler as QueueConsumerHandler<unknown>,
      options: { ...DEFAULT_OPTIONS, ...options },
    });
  }

  /** Pending (non-dead) job count for `name` — a test/observability helper. */
  pending(name: string): number {
    return this.#store.pending(name);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    // Don't keep the event loop alive solely for the poller.
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    // Let any in-flight tick finish.
    while (this.#ticking) await new Promise((r) => setTimeout(r, 5));
  }

  /** Process one delivery pass across all queues. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const [name, reg] of this.#consumers) {
        await this.#deliver(name, reg);
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #deliver(name: string, reg: Registration): Promise<void> {
    const now = this.#now();
    const claimed = this.#store.claim(
      name,
      now,
      reg.options.maxBatchSize,
      now + reg.options.visibilityTimeoutMs,
    );
    if (claimed.length === 0) return;

    const acked = new Set<number>();
    const retried = new Map<number, number | undefined>();
    // Parse bodies defensively: an un-parseable body is a poison pill that can
    // never succeed, so drop it rather than let it block the queue forever
    // (the parse would otherwise throw out of the tick, leaving the job leased
    // and redelivered indefinitely).
    const live: JobRow[] = [];
    const messages: Message<unknown>[] = [];
    for (const row of claimed) {
      try {
        const body: unknown = JSON.parse(row.body);
        messages.push(makeMessage(row, body, this.#now(), acked, retried));
        live.push(row);
      } catch {
        this.#store.ack(row.id);
      }
    }
    if (messages.length === 0) return;

    const batch = {
      queue: name,
      messages,
      ackAll(): void {
        for (const row of live) acked.add(row.id);
      },
      retryAll(options?: { delaySeconds?: number }): void {
        for (const row of live) retried.set(row.id, options?.delaySeconds);
      },
    } as unknown as MessageBatch<unknown>;

    let threw = false;
    try {
      await reg.handler(batch);
    } catch {
      // A thrown consumer retries the whole batch (Cloudflare semantics).
      threw = true;
    }

    for (const row of live) {
      if (retried.has(row.id)) {
        // Explicit per-message retry (wins over a throw or an ack).
        this.#requeue(row, reg.options, retried.get(row.id));
      } else if (acked.has(row.id)) {
        this.#store.ack(row.id);
      } else if (threw) {
        // A thrown handler retries every still-unacked message.
        this.#requeue(row, reg.options, undefined);
      } else {
        // Returned without an explicit decision → auto-ack.
        this.#store.ack(row.id);
      }
    }
  }

  #requeue(
    row: JobRow,
    options: Required<ConsumerOptions>,
    delaySeconds?: number,
  ): void {
    const attempts = row.attempts + 1;
    if (attempts >= options.maxRetries) {
      this.#store.reschedule(row.id, attempts, this.#now(), true);
      return;
    }
    const backoff =
      delaySeconds !== undefined
        ? delaySeconds * 1000
        : options.baseRetryDelayMs * 2 ** (attempts - 1);
    this.#store.reschedule(row.id, attempts, this.#now() + backoff, false);
  }
}

function makeMessage(
  row: JobRow,
  body: unknown,
  timestamp: number,
  acked: Set<number>,
  retried: Map<number, number | undefined>,
): Message<unknown> {
  return {
    id: String(row.id),
    timestamp: new Date(timestamp),
    body,
    attempts: row.attempts + 1,
    ack(): void {
      acked.add(row.id);
    },
    retry(options?: { delaySeconds?: number }): void {
      retried.set(row.id, options?.delaySeconds);
    },
  } as unknown as Message<unknown>;
}

function delayMs(options?: { delaySeconds?: number }): number {
  return (options?.delaySeconds ?? 0) * 1000;
}
