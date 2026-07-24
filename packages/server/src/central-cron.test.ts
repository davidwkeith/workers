import { describe, it, expect, vi } from "vitest";
import type { ScheduledController } from "@cloudflare/workers-types";
import { CentralCronScheduler } from "./central-cron.js";
import { LibsqlKv } from "./libsql-kv.js";
import { createFakeLibsqlClient } from "./central-test-harness.js";

function fakeKv(): LibsqlKv {
  return new LibsqlKv(createFakeLibsqlClient());
}

describe("CentralCronScheduler", () => {
  it("fires a registered handler with a ScheduledController shape when it wins the tick lease", async () => {
    const scheduler = new CentralCronScheduler({
      kv: fakeKv(),
      now: () => 12000,
    });
    const seen: ScheduledController[] = [];
    scheduler.register(
      "job",
      (c) => {
        seen.push(c);
      },
      1000,
      "*/5 * * * *",
    );

    await scheduler.fireAll();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scheduledTime).toBe(12000);
    expect(seen[0]?.cron).toBe("*/5 * * * *");
  });

  it("exactly one of two replicas' schedulers runs a given tick bucket", async () => {
    const kv = fakeKv();
    const schedulerA = new CentralCronScheduler({ kv, now: () => 5000 });
    const schedulerB = new CentralCronScheduler({ kv, now: () => 5000 });
    let runsA = 0;
    let runsB = 0;
    schedulerA.register("job", () => void runsA++, 1000);
    schedulerB.register("job", () => void runsB++, 1000);

    await Promise.all([schedulerA.fireAll(), schedulerB.fireAll()]);
    expect(runsA + runsB).toBe(1);
  });

  it("the next tick bucket admits a runner again (possibly a different replica)", async () => {
    const kv = fakeKv();
    let clock = 0;
    const schedulerA = new CentralCronScheduler({ kv, now: () => clock });
    const schedulerB = new CentralCronScheduler({ kv, now: () => clock });
    let runsA = 0;
    let runsB = 0;
    schedulerA.register("job", () => void runsA++, 1000);
    schedulerB.register("job", () => void runsB++, 1000);

    clock = 1000; // bucket 1000
    await Promise.all([schedulerA.fireAll(), schedulerB.fireAll()]);
    clock = 2000; // bucket 2000 — a fresh lease key, independent of bucket 1000
    await Promise.all([schedulerA.fireAll(), schedulerB.fireAll()]);

    expect(runsA + runsB).toBe(2);
  });

  it("does not re-enter a still-running handler", async () => {
    const scheduler = new CentralCronScheduler({ kv: fakeKv() });
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const started = new Promise<void>((resolveStarted) => {
      scheduler.register(
        "job",
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          resolveStarted();
          await new Promise<void>((r) => {
            release = r;
          });
          active -= 1;
        },
        1000,
      );
    });

    const first = scheduler.fireAll();
    const second = scheduler.fireAll(); // no-op while running (or while still claiming the tick lease)
    // The tick-lease claim is async (unlike `@dwk/cf-shims`'s local-mode
    // `CronScheduler`, which invokes the handler synchronously), so wait for
    // the handler to actually start before releasing it.
    await started;
    release();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  it("swallows handler errors and logs a warning, rather than crashing the host", async () => {
    const warnings: string[] = [];
    const scheduler = new CentralCronScheduler({
      kv: fakeKv(),
      logger: {
        debug: () => {},
        info: () => {},
        warn: (event) => warnings.push(event),
        error: () => {},
      },
    });
    scheduler.register(
      "job",
      () => {
        throw new Error("scheduled boom");
      },
      1000,
    );
    await expect(scheduler.fireAll()).resolves.toBeUndefined();
    expect(warnings).toEqual(["central_cron.handler_error"]);
  });

  it("logs (rather than throws) a KV claim failure and skips the tick", async () => {
    const warnings: string[] = [];
    const failingKv = {
      atomic: () => {
        throw new Error("kv unreachable");
      },
    } as unknown as LibsqlKv;
    const scheduler = new CentralCronScheduler({
      kv: failingKv,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (event) => warnings.push(event),
        error: () => {},
      },
    });
    let ran = false;
    scheduler.register("job", () => void (ran = true), 1000);
    await expect(scheduler.fireAll()).resolves.toBeUndefined();
    expect(ran).toBe(false);
    expect(warnings).toEqual(["central_cron.claim_error"]);
  });

  it("start()/stop() ticks on the registered interval and can be stopped cleanly", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new CentralCronScheduler({ kv: fakeKv() });
      let runs = 0;
      scheduler.register("job", () => void runs++, 100);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(350);
      expect(runs).toBeGreaterThanOrEqual(3);
      await scheduler.stop();
      const countAtStop = runs;
      await vi.advanceTimersByTimeAsync(500);
      expect(runs).toBe(countAtStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
