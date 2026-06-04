import { describe, expect, it, vi } from "vitest";

import type { Logger, Metrics } from "@dwk/log";

import { createIntrospectionHandler } from "./introspection";
import { OAuthLogEvent } from "./log";

function spyLogger(): Logger & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    debug: (e) => calls.push(["debug", e]),
    info: (e) => calls.push(["info", e]),
    warn: (e) => calls.push(["warn", e]),
    error: (e) => calls.push(["error", e]),
  };
}

describe("observability wiring", () => {
  it("emits the same event to the logger and the metrics sink", async () => {
    const logger = spyLogger();
    const metrics: Metrics = { count: vi.fn(), observe: vi.fn() };
    const handler = createIntrospectionHandler({
      lookupToken: async () => ({ scope: "read", expiresAt: 9999 }),
      authenticate: () => true,
      now: () => 1000,
      logger,
      metrics,
    });

    await handler(
      new Request("https://as.example/introspect", {
        method: "POST",
        body: new URLSearchParams({ token: "tok" }),
      }),
    );

    expect(logger.calls).toContainEqual([
      "info",
      OAuthLogEvent.IntrospectionActive,
    ]);
    expect(metrics.count).toHaveBeenCalledWith(
      OAuthLogEvent.IntrospectionActive,
      expect.any(Object),
    );
  });

  it("defaults to silent no-op sinks when none are configured", async () => {
    // No logger/metrics supplied: the handler must still work without throwing.
    const handler = createIntrospectionHandler({
      lookupToken: async () => null,
      authenticate: () => true,
    });
    const res = await handler(
      new Request("https://as.example/introspect", {
        method: "POST",
        body: new URLSearchParams({ token: "tok" }),
      }),
    );
    expect(await res.json()).toEqual({ active: false });
  });
});
