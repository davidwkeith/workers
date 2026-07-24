/**
 * KV-backed durable at-least-once queue emulation — host-contract §3.6,
 * issue #399.
 *
 * Mirrors alarms.ts' KV-indexed-schedule shape (issue #398): each message is
 * indexed directly in KV under a due-time-ordered key so a poll can find due
 * entries with one range scan. Unlike alarms (one slot per Durable Object
 * id), a queue has no "current schedule for this id" to replace — every
 * `send`/`sendBatch` call writes an independent entry keyed by a random id,
 * so no secondary by-id index is needed.
 *
 * Like the alarm dispatcher, this package never starts its own timer:
 * `QueueBroker.pollQueues()` is an exported tick function the composing app
 * wires to whatever periodic trigger its runtime offers (`Deno.cron()` on
 * Deno Deploy) — sharing that tick with
 * `DurableObjectNamespaceLike.pollAlarms()` is the deployment-level pairing
 * deno-deploy-design.md §3.3 describes; nothing here requires it.
 *
 * @see spec/packages/deno-host.md "Design: KV-backed queue emulation (issue
 * #399)"
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";

const DUE_PREFIX = "dwk_queue_due";

interface MessageRecord {
  readonly body: unknown;
  readonly attempts: number;
}

function dueKey(queueName: string, dueAtMs: number, id: string): KvKey {
  return [DUE_PREFIX, queueName, dueAtMs, id];
}

async function enqueueMessage(
  kv: DenoKvLike,
  queueName: string,
  body: unknown,
  dueAtMs: number,
  attempts: number,
  id: string,
): Promise<void> {
  await kv.set(dueKey(queueName, dueAtMs, id), {
    body,
    attempts,
  } satisfies MessageRecord);
}

interface DueMessageEntry {
  readonly key: KvKey;
  readonly versionstamp: string;
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
}

/** Range-scan due entries for `queueName` at or before `now`, oldest first. */
async function listDueMessages(
  kv: DenoKvLike,
  queueName: string,
  now: number,
  limit: number,
): Promise<DueMessageEntry[]> {
  const out: DueMessageEntry[] = [];
  const iter = kv.list<MessageRecord>(
    {
      prefix: [DUE_PREFIX, queueName],
      end: [DUE_PREFIX, queueName, now + 1],
    },
    { limit },
  );
  for await (const entry of iter) {
    out.push({
      key: entry.key,
      versionstamp: entry.versionstamp as string,
      id: entry.key[3] as string,
      body: entry.value.body,
      attempts: entry.value.attempts,
    });
  }
  return out;
}

/**
 * Atomically claim a due entry so only one concurrent poller delivers it.
 * Claiming deletes the due-index entry outright — that alone is enough to
 * satisfy an implicit ack; a redelivery (default-redeliver, explicit
 * `retry()`, or a rethrown handler) writes a **new** entry via
 * {@link enqueueMessage} rather than un-deleting this one. Returns false if
 * another poller already claimed it first.
 */
async function claimDueMessage(
  kv: DenoKvLike,
  entry: { readonly key: KvKey; readonly versionstamp: string },
): Promise<boolean> {
  const result = await kv
    .atomic()
    .check({ key: entry.key, versionstamp: entry.versionstamp })
    .delete(entry.key)
    .commit();
  return result.ok;
}

/* ---------- public surface: host-contract §3.6 shapes ---------- */

export interface MessageSendOptions {
  readonly delaySeconds?: number;
}

export interface MessageSendRequestLike<T = unknown> {
  readonly body: T;
  readonly delaySeconds?: number;
}

export interface MessageLike<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  /** Delivery attempt counter, starting at 1 and incremented on each redelivery. */
  readonly attempts: number;
  /** Marks this message consumed; an acked message MUST NOT be redelivered. */
  ack(): void;
  /** Requests redelivery no sooner than roughly `delaySeconds` later. */
  retry(options?: MessageSendOptions): void;
}

export interface MessageBatchLike<T = unknown> {
  readonly queue: string;
  readonly messages: readonly MessageLike<T>[];
}

export interface QueueLike<T = unknown> {
  send(body: T, options?: MessageSendOptions): Promise<void>;
  sendBatch(
    messages: Iterable<MessageSendRequestLike<T>>,
    options?: MessageSendOptions,
  ): Promise<void>;
}

export type QueueConsumerHandler<T = unknown> = (
  batch: MessageBatchLike<T>,
) => Promise<void>;

export interface ConsumerOptions {
  /** Maximum messages delivered in one poll pass (default 10). */
  readonly maxBatchSize?: number;
  /** Delivery attempts before a message is dropped as a dead-letter
   *  backstop — host-contract §3.6 "SHOULD apply a bounded redelivery cap"
   *  (default 5). The consumers this package backs self-limit via
   *  `message.attempts` already and never rely on a DLQ existing. */
  readonly maxAttempts?: number;
  /** Base backoff in ms for a redelivery with no explicit `delaySeconds`;
   *  doubles per attempt (default 1000). */
  readonly baseRetryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<ConsumerOptions> = {
  maxBatchSize: 10,
  maxAttempts: 5,
  baseRetryDelayMs: 1000,
};

interface Registration {
  readonly handler: QueueConsumerHandler<unknown>;
  readonly options: Required<ConsumerOptions>;
}

type Decision =
  | { readonly type: "ack" }
  | { readonly type: "retry"; readonly delaySeconds?: number };

function delayMs(options?: MessageSendOptions): number {
  return (options?.delaySeconds ?? 0) * 1000;
}

function makeMessage(
  entry: DueMessageEntry,
  now: number,
  decisions: Map<string, Decision>,
): MessageLike<unknown> {
  return {
    id: entry.id,
    timestamp: new Date(now),
    body: entry.body,
    attempts: entry.attempts + 1,
    ack(): void {
      decisions.set(entry.id, { type: "ack" });
    },
    retry(options?: MessageSendOptions): void {
      decisions.set(entry.id, {
        type: "retry",
        delaySeconds: options?.delaySeconds,
      });
    },
  };
}

export interface QueueBrokerOptions {
  /** Clock source for `send`/`sendBatch`/`pollQueues`, for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Hands out `Queue`-shaped producer bindings, registers per-queue consumers,
 * and drives delivery from an externally-triggered {@link pollQueues} tick —
 * host-contract §3.6. `send`/`sendBatch` accept batches of any size (no
 * artificial cap), satisfying the "at least Cloudflare's limits" floor by
 * construction.
 */
export class QueueBroker {
  readonly #kv: DenoKvLike;
  readonly #consumers = new Map<string, Registration>();
  readonly #now: () => number;

  constructor(kv: DenoKvLike, options: QueueBrokerOptions = {}) {
    this.#kv = kv;
    this.#now = options.now ?? Date.now;
  }

  /** A {@link QueueLike} producer binding for `name`. */
  producer<T = unknown>(name: string): QueueLike<T> {
    const kv = this.#kv;
    const now = this.#now;
    return {
      async send(body: T, options?: MessageSendOptions): Promise<void> {
        await enqueueMessage(
          kv,
          name,
          body,
          now() + delayMs(options),
          0,
          crypto.randomUUID(),
        );
      },
      async sendBatch(
        messages: Iterable<MessageSendRequestLike<T>>,
        options?: MessageSendOptions,
      ): Promise<void> {
        for (const req of messages) {
          await enqueueMessage(
            kv,
            name,
            req.body,
            now() +
              delayMs({ delaySeconds: req.delaySeconds }) +
              delayMs(options),
            0,
            crypto.randomUUID(),
          );
        }
      },
    };
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

  /**
   * One scan-and-dispatch pass across every registered consumer's due
   * messages. Wire this to whatever periodic trigger the composing app's
   * runtime offers (`Deno.cron()` on Deno Deploy) — the package never starts
   * its own timer.
   */
  async pollQueues(options: { now?: number } = {}): Promise<void> {
    const now = options.now ?? this.#now();
    for (const [name, reg] of this.#consumers) {
      await this.#deliver(name, reg, now);
    }
  }

  async #deliver(name: string, reg: Registration, now: number): Promise<void> {
    const due = await listDueMessages(
      this.#kv,
      name,
      now,
      reg.options.maxBatchSize,
    );
    if (due.length === 0) return;

    const claimed: DueMessageEntry[] = [];
    for (const entry of due) {
      if (await claimDueMessage(this.#kv, entry)) claimed.push(entry);
    }
    if (claimed.length === 0) return;

    const decisions = new Map<string, Decision>();
    const messages = claimed.map((entry) => makeMessage(entry, now, decisions));
    const batch: MessageBatchLike<unknown> = { queue: name, messages };

    try {
      await reg.handler(batch);
    } catch {
      // host-contract §3.6: a message neither acked nor retried when the
      // consumer invocation ends — including by throwing — MUST be
      // redelivered. A throw and a quiet return-without-deciding hit the
      // exact same fallthrough below (`decisions.get` returns undefined),
      // so nothing case-specific is needed here beyond not propagating.
    }

    for (const entry of claimed) {
      const decision = decisions.get(entry.id);
      if (decision?.type === "ack") continue; // claim already deleted the due entry
      await this.#requeue(
        name,
        entry,
        reg.options,
        decision?.type === "retry" ? decision.delaySeconds : undefined,
        now,
      );
    }
  }

  async #requeue(
    name: string,
    entry: DueMessageEntry,
    options: Required<ConsumerOptions>,
    delaySeconds: number | undefined,
    now: number,
  ): Promise<void> {
    const attempts = entry.attempts + 1;
    if (attempts >= options.maxAttempts) return; // dead-letter backstop: drop
    const backoff =
      delaySeconds !== undefined
        ? delaySeconds * 1000
        : options.baseRetryDelayMs * 2 ** (attempts - 1);
    await enqueueMessage(
      this.#kv,
      name,
      entry.body,
      now + backoff,
      attempts,
      entry.id,
    );
  }
}

/** Construct a {@link QueueBroker} over an injected `DenoKvLike`. */
export function createQueueBroker(
  kv: DenoKvLike,
  options: QueueBrokerOptions = {},
): QueueBroker {
  return new QueueBroker(kv, options);
}
