import { describe, it, expect } from "vitest";
import { WaitUntilTracker, HostExecutionContext } from "./context";

describe("HostExecutionContext / WaitUntilTracker", () => {
  it("tracks waitUntil work and drains it; props and passThroughOnException are no-ops", async () => {
    const tracker = new WaitUntilTracker();
    const ctx = new HostExecutionContext(tracker);
    let done = false;
    ctx.waitUntil(
      new Promise<void>((r) =>
        setTimeout(() => {
          done = true;
          r();
        }, 5),
      ),
    );
    expect(tracker.size).toBe(1);
    ctx.passThroughOnException();
    expect(ctx.props).toEqual({});

    await tracker.drain();
    expect(done).toBe(true);
    expect(tracker.size).toBe(0);
  });

  it("swallows a rejected waitUntil promise so drain never rejects", async () => {
    const tracker = new WaitUntilTracker();
    new HostExecutionContext(tracker).waitUntil(
      Promise.reject(new Error("background failure")),
    );
    await expect(tracker.drain()).resolves.toBeUndefined();
  });
});
