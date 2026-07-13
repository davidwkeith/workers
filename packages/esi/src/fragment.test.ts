import { describe, expect, it, vi } from "vitest";
import { resolveFragment } from "./fragment.js";
import type { EsiToken } from "./tokenize.js";
import type { Logger } from "@dwk/log";

type IncludeToken = Extract<EsiToken, { kind: "include" }>;

function include(overrides: Partial<IncludeToken> = {}): IncludeToken {
  return { kind: "include", src: "https://example.com/frag", ...overrides };
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("resolveFragment", () => {
  it("splices in the fetched body on success", async () => {
    const fetchFn = vi.fn(async () => new Response("<p>fragment</p>"));
    const body = await resolveFragment(include(), { fetch: fetchFn });
    expect(body).toBe("<p>fragment</p>");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("resolves to '' and logs at debug when onerror=continue and the fetch fails", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    const logger = fakeLogger();
    const body = await resolveFragment(include({ onerror: "continue" }), {
      fetch: fetchFn,
      logger,
    });
    expect(body).toBe("");
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves to '' and logs at debug when onerror=continue and the fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const logger = fakeLogger();
    const body = await resolveFragment(include({ onerror: "continue" }), {
      fetch: fetchFn,
      logger,
    });
    expect(body).toBe("");
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("retries against alt once on failure, returning the alt body on success", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response("<p>fallback</p>"));
    const logger = fakeLogger();
    const body = await resolveFragment(
      include({ alt: "https://example.com/fallback" }),
      { fetch: fetchFn, logger },
    );
    expect(body).toBe("<p>fallback</p>");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resolves to '' logged at warn when both src and alt fail", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    const logger = fakeLogger();
    const body = await resolveFragment(
      include({ alt: "https://example.com/fallback" }),
      { fetch: fetchFn, logger },
    );
    expect(body).toBe("");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("resolves to '' logged at warn when there is no onerror and no alt", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    const logger = fakeLogger();
    const body = await resolveFragment(include(), { fetch: fetchFn, logger });
    expect(body).toBe("");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("resolves to '' when the fragment body exceeds maxFragmentBytes", async () => {
    const fetchFn = vi.fn(
      async () => new Response("x".repeat(1000), { status: 200 }),
    );
    const logger = fakeLogger();
    const body = await resolveFragment(include(), {
      fetch: fetchFn,
      logger,
      maxFragmentBytes: 10,
    });
    expect(body).toBe("");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("catches an SsrfError from safeFetch like any other fetch failure", async () => {
    const fetchFn = vi.fn(async () => new Response("unreachable"));
    const logger = fakeLogger();
    const body = await resolveFragment(
      include({ src: "http://169.254.169.254/frag" }),
      { fetch: fetchFn, logger },
    );
    expect(body).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative src against baseUrl before fetching", async () => {
    const fetchFn = vi.fn(async (input: string) => {
      expect(input).toBe("https://example.com/fragments/live");
      return new Response("<p>live</p>");
    });
    const body = await resolveFragment(include({ src: "/fragments/live" }), {
      fetch: fetchFn,
      baseUrl: "https://example.com/page",
    });
    expect(body).toBe("<p>live</p>");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("treats a relative src with no baseUrl configured as a fragment failure", async () => {
    const fetchFn = vi.fn(async () => new Response("should not be reached"));
    const logger = fakeLogger();
    const body = await resolveFragment(include({ src: "/fragments/live" }), {
      fetch: fetchFn,
      logger,
    });
    expect(body).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
