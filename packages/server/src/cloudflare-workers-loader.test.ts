import { describe, it, expect, vi } from "vitest";

vi.mock("node:module", () => ({ register: vi.fn() }));

import { register } from "node:module";
import {
  resolve,
  registerCloudflareWorkers,
} from "./cloudflare-workers-loader";

describe("cloudflare:workers loader hook", () => {
  it("redirects cloudflare:workers to the shim and short-circuits", async () => {
    const next = vi.fn();
    const result = await resolve(
      "cloudflare:workers",
      { conditions: [] },
      next as never,
    );
    expect(result.url).toMatch(/cloudflare-workers\.js$/);
    expect(result.shortCircuit).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("defers every other specifier to nextResolve", async () => {
    const next = vi.fn(async () => ({ url: "file:///x.js" }));
    const result = await resolve("node:fs", { conditions: [] }, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(result.url).toBe("file:///x.js");
  });

  it("registers the loader hook in-process", () => {
    registerCloudflareWorkers();
    expect(register).toHaveBeenCalledOnce();
  });
});
