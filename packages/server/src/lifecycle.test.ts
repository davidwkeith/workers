import { describe, it, expect } from "vitest";
import type {
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import { bindQueueConsumer, bindScheduledTask } from "./lifecycle";
import { WaitUntilTracker } from "./context";

const emptyBatch = { queue: "q", messages: [] } as unknown as MessageBatch<{
  n: number;
}>;
const controller = {
  scheduledTime: 0,
  cron: "",
  noRetry() {},
} as unknown as ScheduledController;

describe("bindQueueConsumer", () => {
  it("binds env and a fresh ExecutionContext to a Cloudflare-shaped consumer", async () => {
    const tracker = new WaitUntilTracker();
    let seenEnv: unknown;
    let ctxHadWaitUntil = false;
    const bound = bindQueueConsumer<{ n: number }>(
      async (batch, env, ctx) => {
        seenEnv = env;
        ctxHadWaitUntil = typeof ctx.waitUntil === "function";
        expect(batch.queue).toBe("q");
      },
      { SECRET: "shh" },
      tracker,
    );

    await bound(emptyBatch);
    expect(seenEnv).toEqual({ SECRET: "shh" });
    expect(ctxHadWaitUntil).toBe(true);
  });

  it("funnels the consumer's waitUntil work into the provided tracker", async () => {
    const tracker = new WaitUntilTracker();
    let resolved = false;
    const bound = bindQueueConsumer(
      async (_batch, _env, ctx) => {
        ctx.waitUntil(
          new Promise<void>((r) =>
            setTimeout(() => {
              resolved = true;
              r();
            }, 5),
          ),
        );
      },
      {},
      tracker,
    );

    await bound(emptyBatch);
    expect(resolved).toBe(false); // background work outlives the handler
    await tracker.drain();
    expect(resolved).toBe(true);
  });
});

describe("bindScheduledTask", () => {
  it("binds env and an ExecutionContext to a Cloudflare-shaped scheduled handler", async () => {
    const tracker = new WaitUntilTracker();
    let seenEnv: unknown;
    let seenCron = "";
    const bound = bindScheduledTask(
      async (event, env, _ctx) => {
        seenEnv = env;
        seenCron = event.cron;
      },
      { DB: {} },
      tracker,
    );

    await bound(controller);
    expect(seenEnv).toEqual({ DB: {} });
    expect(seenCron).toBe("");
  });

  it("tracks scheduled background work for shutdown draining", async () => {
    const tracker = new WaitUntilTracker();
    let done = false;
    const bound = bindScheduledTask(
      async (_event, _env, ctx) => {
        ctx.waitUntil(Promise.resolve().then(() => void (done = true)));
      },
      {},
      tracker,
    );
    await bound(controller);
    await tracker.drain();
    expect(done).toBe(true);
  });
});
