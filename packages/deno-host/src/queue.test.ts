import { describe, it, expect } from "vitest";
import { createQueueBroker, type MessageBatchLike } from "./queue.js";
import { FakeDenoKv } from "./test-harness.js";

describe("QueueBroker (host-contract §3.6)", () => {
  it("delivers a sent message with attempts starting at 1", async () => {
    const broker = createQueueBroker(new FakeDenoKv());
    const producer = broker.producer<{ n: number }>("mentions");
    const received: MessageBatchLike<{ n: number }>[] = [];
    broker.consumer<{ n: number }>("mentions", async (batch) => {
      received.push(batch);
      for (const m of batch.messages) m.ack();
    });

    await producer.send({ n: 1 });
    await broker.pollQueues();

    expect(received).toHaveLength(1);
    expect(received[0]?.queue).toBe("mentions");
    expect(received[0]?.messages).toHaveLength(1);
    expect(received[0]?.messages[0]?.body).toEqual({ n: 1 });
    expect(received[0]?.messages[0]?.attempts).toBe(1);
  });

  it("an acked message is not redelivered", async () => {
    const broker = createQueueBroker(new FakeDenoKv());
    const producer = broker.producer("q");
    let deliveries = 0;
    broker.consumer("q", async (batch) => {
      deliveries++;
      for (const m of batch.messages) m.ack();
    });

    await producer.send("hello");
    await broker.pollQueues();
    await broker.pollQueues();

    expect(deliveries).toBe(1);
  });

  it("a message neither acked nor retried is redelivered (host-contract default)", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    const attemptsSeen: number[] = [];
    broker.consumer("q", async (batch) => {
      for (const m of batch.messages) attemptsSeen.push(m.attempts);
      // Deliberately decide nothing.
    });

    await producer.send("hello");
    await broker.pollQueues();
    now += 60_000; // clear any default backoff
    await broker.pollQueues();

    expect(attemptsSeen).toEqual([1, 2]);
  });

  it("a throwing handler redelivers every unacked message in the batch", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    let calls = 0;
    broker.consumer("q", async (batch) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      for (const m of batch.messages) m.ack();
    });

    await producer.send("hello");
    await broker.pollQueues();
    now += 60_000;
    await broker.pollQueues();

    expect(calls).toBe(2);
  });

  it("acks made before a later throw are honored — only the rest redeliver", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    const delivered: string[][] = [];
    let calls = 0;
    broker.consumer("q", async (batch) => {
      calls++;
      const bodies = batch.messages.map((m) => m.body as string);
      delivered.push(bodies);
      for (const m of batch.messages) {
        if (m.body === "keep") m.ack();
      }
      if (calls === 1) throw new Error("boom");
    });

    await producer.sendBatch([{ body: "keep" }, { body: "redo" }]);
    await broker.pollQueues();
    now += 60_000;
    await broker.pollQueues();

    // Host-contract §3.6: ordering is NOT guaranteed — sort before comparing.
    expect(delivered.map((batch) => [...batch].sort())).toEqual([
      ["keep", "redo"],
      ["redo"],
    ]);
  });

  it("explicit retry({delaySeconds}) reschedules at now + delay and increments attempts", async () => {
    let now = 1000;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    const attemptsSeen: number[] = [];
    broker.consumer(
      "q",
      async (batch) => {
        for (const m of batch.messages) {
          attemptsSeen.push(m.attempts);
          if (m.attempts === 1) m.retry({ delaySeconds: 5 });
          else m.ack();
        }
      },
      { maxAttempts: 10 },
    );

    await producer.send("hello");
    await broker.pollQueues();
    // Not due yet.
    now += 4999;
    await broker.pollQueues();
    expect(attemptsSeen).toEqual([1]);
    now += 1;
    await broker.pollQueues();
    expect(attemptsSeen).toEqual([1, 2]);
  });

  it("default backoff doubles per attempt when no delaySeconds is given", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    const attemptsSeen: number[] = [];
    broker.consumer(
      "q",
      async (batch) => {
        for (const m of batch.messages) attemptsSeen.push(m.attempts);
      },
      { baseRetryDelayMs: 1000, maxAttempts: 10 },
    );

    await producer.send("hello");
    await broker.pollQueues();
    now += 999; // base backoff for attempt 1 not elapsed
    await broker.pollQueues();
    expect(attemptsSeen).toEqual([1]);
    now += 1;
    await broker.pollQueues();
    expect(attemptsSeen).toEqual([1, 2]);
    now += 1999; // doubled backoff for attempt 2 not elapsed
    await broker.pollQueues();
    expect(attemptsSeen).toEqual([1, 2]);
    now += 1;
    await broker.pollQueues();
    expect(attemptsSeen).toEqual([1, 2, 3]);
  });

  it("drops a message once it exceeds maxAttempts (dead-letter backstop)", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    const attemptsSeen: number[] = [];
    broker.consumer(
      "q",
      async (batch) => {
        for (const m of batch.messages) attemptsSeen.push(m.attempts);
        // Never ack/retry — always redeliver until the cap kicks in.
      },
      { maxAttempts: 3, baseRetryDelayMs: 0 },
    );

    await producer.send("hello");
    for (let i = 0; i < 5; i++) {
      await broker.pollQueues();
      now += 1;
    }

    // maxAttempts: 3 allows 3 deliveries; the 4th requeue attempt hits the
    // cap and the message is dropped instead of requeued.
    expect(attemptsSeen).toEqual([1, 2, 3]);
  });

  it("sendBatch enqueues every entry, delivered together up to maxBatchSize", async () => {
    const broker = createQueueBroker(new FakeDenoKv());
    const producer = broker.producer<number>("q");
    const delivered: number[][] = [];
    broker.consumer<number>(
      "q",
      async (batch) => {
        delivered.push(batch.messages.map((m) => m.body));
        for (const m of batch.messages) m.ack();
      },
      { maxBatchSize: 2 },
    );

    await producer.sendBatch([{ body: 1 }, { body: 2 }, { body: 3 }]);
    await broker.pollQueues();
    await broker.pollQueues();

    expect(delivered.flat().sort()).toEqual([1, 2, 3]);
    expect(delivered.every((batch) => batch.length <= 2)).toBe(true);
  });

  it("sendBatch: a message-level delaySeconds overrides the batch-level default rather than adding to it", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer<string>("q");
    const delivered: string[] = [];
    broker.consumer<string>("q", async (batch) => {
      for (const m of batch.messages) {
        delivered.push(m.body);
        m.ack();
      }
    });

    await producer.sendBatch(
      [{ body: "message-level", delaySeconds: 10 }, { body: "batch-default" }],
      { delaySeconds: 30 },
    );

    now = 10_000; // message-level delay elapsed; batch-level default has not
    await broker.pollQueues();
    expect(delivered).toEqual(["message-level"]);

    now = 30_000; // batch-level default now elapsed too
    await broker.pollQueues();
    expect(delivered).toEqual(["message-level", "batch-default"]);
  });

  it("does not deliver a message scheduled in the future", async () => {
    let now = 0;
    const broker = createQueueBroker(new FakeDenoKv(), { now: () => now });
    const producer = broker.producer("q");
    let deliveries = 0;
    broker.consumer("q", async (batch) => {
      deliveries++;
      for (const m of batch.messages) m.ack();
    });

    await producer.send("hello", { delaySeconds: 60 });
    await broker.pollQueues();
    expect(deliveries).toBe(0);
    now += 61_000;
    await broker.pollQueues();
    expect(deliveries).toBe(1);
  });

  it("queues are isolated — a consumer only sees its own queue's messages", async () => {
    const kv = new FakeDenoKv();
    const broker = createQueueBroker(kv);
    const a = broker.producer("a");
    const b = broker.producer("b");
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    broker.consumer("a", async (batch) => {
      for (const m of batch.messages) {
        seenA.push(m.body);
        m.ack();
      }
    });
    broker.consumer("b", async (batch) => {
      for (const m of batch.messages) {
        seenB.push(m.body);
        m.ack();
      }
    });

    await a.send("from-a");
    await b.send("from-b");
    await broker.pollQueues();

    expect(seenA).toEqual(["from-a"]);
    expect(seenB).toEqual(["from-b"]);
  });

  it("two concurrent poll passes racing the same due message deliver it only once", async () => {
    const kv = new FakeDenoKv();
    const broker = createQueueBroker(kv);
    const producer = broker.producer("q");
    let deliveries = 0;
    broker.consumer("q", async (batch) => {
      deliveries++;
      for (const m of batch.messages) m.ack();
    });

    await producer.send("hello");
    await Promise.all([broker.pollQueues(), broker.pollQueues()]);

    expect(deliveries).toBe(1);
  });

  it("an unregistered queue's messages sit inert — no consumer, no delivery", async () => {
    const broker = createQueueBroker(new FakeDenoKv());
    const producer = broker.producer("nobody-home");
    await producer.send("hello");
    await expect(broker.pollQueues()).resolves.toBeUndefined();
  });
});
