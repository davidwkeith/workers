import { describe, it, expect, vi } from "vitest";
import {
  consoleLogger,
  hostFromUrl,
  noopLogger,
  withContext,
  type ConsoleLike,
} from "./index";

function spySink(): ConsoleLike & {
  records: { level: string; line: string }[];
} {
  const records: { level: string; line: string }[] = [];
  const push = (level: string) => (line: unknown) =>
    records.push({ level, line: String(line) });
  return {
    records,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

describe("noopLogger", () => {
  it("accepts calls at every level and returns nothing", () => {
    expect(noopLogger.debug("x")).toBeUndefined();
    expect(noopLogger.info("x", { a: 1 })).toBeUndefined();
    expect(noopLogger.warn("x")).toBeUndefined();
    expect(noopLogger.error("x", { b: 2 })).toBeUndefined();
  });
});

describe("consoleLogger", () => {
  it("emits one JSON record per call with level, event, time and fields", () => {
    const sink = spySink();
    const logger = consoleLogger({
      console: sink,
      now: () => "2026-06-03T00:00:00.000Z",
    });
    logger.warn("webmention.ssrf.blocked", {
      reason: "blocked_host",
      host: "169.254.169.254",
    });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.level).toBe("warn");
    expect(JSON.parse(sink.records[0]?.line ?? "")).toEqual({
      level: "warn",
      event: "webmention.ssrf.blocked",
      time: "2026-06-03T00:00:00.000Z",
      reason: "blocked_host",
      host: "169.254.169.254",
    });
  });

  it("routes each level to the matching console method", () => {
    const sink = spySink();
    const logger = consoleLogger({ console: sink });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(sink.records.map((r) => r.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("drops records below minLevel", () => {
    const sink = spySink();
    const logger = consoleLogger({ console: sink, minLevel: "warn" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(sink.records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("merges base fields, with per-call fields winning on collision", () => {
    const sink = spySink();
    const logger = consoleLogger({
      console: sink,
      base: { service: "wm", env: "prod" },
      now: () => "t",
    });
    logger.info("evt", { env: "staging", n: 1 });
    expect(JSON.parse(sink.records[0]?.line ?? "")).toEqual({
      level: "info",
      event: "evt",
      time: "t",
      service: "wm",
      env: "staging",
      n: 1,
    });
  });

  it("omits undefined-valued fields via JSON serialization", () => {
    const sink = spySink();
    const logger = consoleLogger({ console: sink, now: () => "t" });
    logger.info("evt", { host: undefined, kept: "yes" });
    const parsed = JSON.parse(sink.records[0]?.line ?? "");
    expect(parsed).not.toHaveProperty("host");
    expect(parsed.kept).toBe("yes");
  });
});

describe("withContext", () => {
  it("merges bound context into every record", () => {
    const inner = consoleLogger({
      console: spySink(),
      now: () => "t",
    });
    const debug = vi.spyOn(inner, "debug");
    const bound = withContext(inner, { requestId: "r1" });
    bound.debug("evt", { a: 1 });
    expect(debug).toHaveBeenCalledWith("evt", { requestId: "r1", a: 1 });
  });

  it("lets per-call fields override the bound context", () => {
    const sink = spySink();
    const bound = withContext(
      consoleLogger({ console: sink, now: () => "t" }),
      {
        requestId: "r1",
      },
    );
    bound.info("evt", { requestId: "r2" });
    expect(JSON.parse(sink.records[0]?.line ?? "").requestId).toBe("r2");
  });
});

describe("hostFromUrl", () => {
  it("returns the host (with non-default port) and nothing else", () => {
    expect(hostFromUrl("https://blog.example/post?secret=1#x")).toBe(
      "blog.example",
    );
    expect(hostFromUrl("http://169.254.169.254:8080/latest/meta-data")).toBe(
      "169.254.169.254:8080",
    );
  });

  it("returns undefined for an unparseable URL", () => {
    expect(hostFromUrl("not a url")).toBeUndefined();
  });
});
