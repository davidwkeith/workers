import { describe, it, expect } from "vitest";
import { CronScheduler } from "./cron.js";
import type { ScheduledController } from "@cloudflare/workers-types";

describe("cron / scheduled shim", () => {
  it("fires registered handlers with a ScheduledController shape", async () => {
    const scheduler = new CronScheduler({ now: () => 12345 });
    const seen: ScheduledController[] = [];
    scheduler.register(
      (c) => {
        seen.push(c);
      },
      1000,
      "*/5 * * * *",
    );

    await scheduler.fireAll();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scheduledTime).toBe(12345);
    expect(seen[0]?.cron).toBe("*/5 * * * *");
  });

  it("does not re-enter a still-running handler", async () => {
    const scheduler = new CronScheduler();
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    scheduler.register(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => {
        release = r;
      });
      active -= 1;
    }, 1000);

    const first = scheduler.fireAll();
    const second = scheduler.fireAll(); // should be a no-op while running
    release();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  it("swallows handler errors so the host keeps running", async () => {
    const scheduler = new CronScheduler();
    scheduler.register(() => {
      throw new Error("scheduled boom");
    }, 1000);
    await expect(scheduler.fireAll()).resolves.toBeUndefined();
  });
});
