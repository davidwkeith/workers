import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueBroker } from "./queue";
import type { MessageBatch, Queue } from "@cloudflare/workers-types";

interface Job {
  readonly value: number;
}

describe("in-process Queue shim", () => {
  it("delivers enqueued jobs to the consumer and auto-acks on return", async () => {
    const broker = new QueueBroker();
    const seen: number[] = [];
    broker.consumer<Job>("q", async (batch: MessageBatch<Job>) => {
      for (const m of batch.messages) seen.push(m.body.value);
    });
    const producer: Queue<Job> = broker.producer<Job>("q");
    await producer.send({ value: 1 });
    await producer.send({ value: 2 });

    expect(broker.pending("q")).toBe(2);
    await broker.tick();
    expect(seen.sort()).toEqual([1, 2]);
    expect(broker.pending("q")).toBe(0);
  });

  it("retries on an explicit message.retry() with backoff", async () => {
    let now = 0;
    const broker = new QueueBroker({ now: () => now });
    let attempts = 0;
    broker.consumer<Job>(
      "q",
      async (batch: MessageBatch<Job>) => {
        for (const m of batch.messages) {
          attempts += 1;
          if (m.attempts === 1) m.retry();
        }
      },
      { baseRetryDelayMs: 1000, visibilityTimeoutMs: 100 },
    );
    await broker.producer<Job>("q").send({ value: 1 });

    await broker.tick();
    expect(attempts).toBe(1);
    expect(broker.pending("q")).toBe(1); // still pending, scheduled later

    // Not yet visible (backoff = 1000ms).
    await broker.tick();
    expect(attempts).toBe(1);

    now += 1000;
    await broker.tick();
    expect(attempts).toBe(2);
    expect(broker.pending("q")).toBe(0);
  });

  it("dead-letters after exhausting maxRetries", async () => {
    let now = 0;
    const broker = new QueueBroker({ now: () => now });
    broker.consumer<Job>(
      "q",
      async (batch: MessageBatch<Job>) => {
        batch.retryAll();
      },
      { maxRetries: 3, baseRetryDelayMs: 10, visibilityTimeoutMs: 1 },
    );
    await broker.producer<Job>("q").send({ value: 1 });

    for (let i = 0; i < 5; i++) {
      await broker.tick();
      now += 10_000;
    }
    expect(broker.pending("q")).toBe(0); // moved to dead-letter, no longer pending
  });

  it("retries the whole batch when the consumer throws", async () => {
    let now = 0;
    const broker = new QueueBroker({ now: () => now });
    let calls = 0;
    broker.consumer<Job>(
      "q",
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      { baseRetryDelayMs: 5, visibilityTimeoutMs: 1 },
    );
    await broker.producer<Job>("q").send({ value: 1 });

    await broker.tick();
    expect(broker.pending("q")).toBe(1);
    now += 1000;
    await broker.tick();
    expect(calls).toBe(2);
    expect(broker.pending("q")).toBe(0);
  });

  it("sendBatch enqueues every message", async () => {
    const broker = new QueueBroker();
    const q = broker.producer<Job>("q");
    await q.sendBatch([{ body: { value: 1 } }, { body: { value: 2 } }]);
    expect(broker.pending("q")).toBe(2);
  });

  it("drops a poison-pill (un-parseable) body instead of looping forever", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dwk-queue-")), "q.sqlite");
    const broker = new QueueBroker({ location: path });
    // Enqueue a valid job, then corrupt a row directly to simulate a bad body.
    await broker.producer<Job>("q").send({ value: 1 });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    db.prepare("UPDATE queue_jobs SET body = ? WHERE id = 1").run("{not json");

    let delivered = 0;
    broker.consumer<Job>("q", async (batch) => {
      delivered += batch.messages.length;
    });
    await broker.tick();
    expect(delivered).toBe(0); // poison pill not delivered
    expect(broker.pending("q")).toBe(0); // and removed, not retried forever
  });

  it("is durable across a restart when SQLite-backed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dwk-queue-")), "q.sqlite");
    const first = new QueueBroker({ location: path });
    await first.producer<Job>("q").send({ value: 42 });
    expect(first.pending("q")).toBe(1);

    // Simulate a reboot: a fresh broker over the same file still sees the job.
    const reopened = new QueueBroker({ location: path });
    const seen: number[] = [];
    reopened.consumer<Job>("q", async (batch: MessageBatch<Job>) => {
      for (const m of batch.messages) seen.push(m.body.value);
    });
    await reopened.tick();
    expect(seen).toEqual([42]);
  });
});
