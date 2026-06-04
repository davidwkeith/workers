import { describe, it, expect, vi } from "vitest";
import {
  analyticsEngineMetrics,
  noopMetrics,
  type AnalyticsEngineDataPoint,
  type AnalyticsEngineDatasetLike,
} from "./index";

function spyDataset(): AnalyticsEngineDatasetLike & {
  points: AnalyticsEngineDataPoint[];
} {
  const points: AnalyticsEngineDataPoint[] = [];
  return {
    points,
    writeDataPoint: (point?: AnalyticsEngineDataPoint) => {
      points.push(point ?? {});
    },
  };
}

describe("noopMetrics", () => {
  it("accepts count/observe calls and returns nothing", () => {
    expect(noopMetrics.count("x")).toBeUndefined();
    expect(noopMetrics.count("x", { a: 1 })).toBeUndefined();
    expect(noopMetrics.observe("x", 5)).toBeUndefined();
    expect(noopMetrics.observe("x", 5, { a: 1 })).toBeUndefined();
  });
});

describe("analyticsEngineMetrics", () => {
  it("count writes event as index1+blob1 and a lead double of 1", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.count("webmention.ssrf.blocked");
    expect(dataset.points).toHaveLength(1);
    expect(dataset.points[0]).toEqual({
      indexes: ["webmention.ssrf.blocked"],
      blobs: ["webmention.ssrf.blocked"],
      doubles: [1],
    });
  });

  it("maps string fields to blobs and numeric/boolean fields to doubles", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.count("webmention.verify.completed", {
      sourceHost: "blog.example",
      targetHost: "example.com",
      links: true,
      status: 200,
    });
    // Fields are emitted in sorted key order: links, sourceHost, status, targetHost.
    // Strings → blobs (after the event), number/boolean → doubles (after lead 1).
    expect(dataset.points[0]).toEqual({
      indexes: ["webmention.verify.completed"],
      blobs: ["webmention.verify.completed", "blog.example", "example.com"],
      doubles: [1, 1, 200],
    });
  });

  it("observe uses the observed value as the lead double", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.observe("webmention.fetch.latency", 123.5, { host: "a.example" });
    expect(dataset.points[0]).toEqual({
      indexes: ["webmention.fetch.latency"],
      blobs: ["webmention.fetch.latency", "a.example"],
      doubles: [123.5],
    });
  });

  it("orders fields deterministically by key, independent of insertion order", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.count("e", { z: "zebra", a: "apple", m: 2, b: 1 });
    // Sorted keys: a, b, m, z → blobs [e, apple, zebra]; doubles [1, b=1, m=2].
    expect(dataset.points[0]?.blobs).toEqual(["e", "apple", "zebra"]);
    expect(dataset.points[0]?.doubles).toEqual([1, 1, 2]);
  });

  it("drops undefined, null, NaN, and non-scalar fields", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.count("e", {
      keep: "yes",
      n: 3,
      gone: undefined,
      nope: null,
      bad: Number.NaN,
      obj: { a: 1 },
      arr: [1, 2],
    });
    expect(dataset.points[0]?.blobs).toEqual(["e", "yes"]);
    expect(dataset.points[0]?.doubles).toEqual([1, 3]);
  });

  it("maps booleans to 1/0", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.count("e", { delivered: false, links: true });
    expect(dataset.points[0]?.doubles).toEqual([1, 0, 1]);
  });

  it("merges base fields, with per-call fields winning on collision", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset, {
      base: { service: "wm", env: "prod" },
    });
    metrics.count("e", { env: "staging" });
    // Sorted keys: env, service → both strings → blobs after event.
    expect(dataset.points[0]?.blobs).toEqual(["e", "staging", "wm"]);
  });

  it("truncates the index to 96 bytes", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    const longEvent = "a".repeat(200);
    metrics.count(longEvent);
    const index = dataset.points[0]?.indexes?.[0];
    expect(typeof index).toBe("string");
    expect((index as string).length).toBe(96);
  });

  it("truncates the index on a UTF-8 char boundary, never splitting a char", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    // "😀" is 4 UTF-8 bytes; 25 of them = 100 bytes, over the 96-byte index cap.
    metrics.count("😀".repeat(25));
    const index = dataset.points[0]?.indexes?.[0] as string;
    expect(new TextEncoder().encode(index).length).toBeLessThanOrEqual(96);
    expect(index).not.toContain("�"); // no split char left behind
    expect(index).toBe("😀".repeat(24)); // 24 * 4 = 96 bytes, exactly
  });

  it("preserves a genuine trailing U+FFFD that the cut does not split", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    // 93 ASCII + U+FFFD (3 bytes) = 96 bytes, then an extra char past the cut.
    metrics.count("a".repeat(93) + "�" + "X");
    const index = dataset.points[0]?.indexes?.[0] as string;
    expect(index).toBe("a".repeat(93) + "�");
  });

  it("caps blob count at 20 (event + 19 fields)", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    const fields: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      // Zero-pad so sort order is stable and predictable.
      fields[`k${String(i).padStart(2, "0")}`] = `v${i}`;
    }
    metrics.count("e", fields);
    expect(dataset.points[0]?.blobs).toHaveLength(20);
    expect(dataset.points[0]?.blobs?.[0]).toBe("e");
  });

  it("caps doubles at 20", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    const fields: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      fields[`k${String(i).padStart(2, "0")}`] = i;
    }
    metrics.count("e", fields);
    expect(dataset.points[0]?.doubles).toHaveLength(20);
    expect(dataset.points[0]?.doubles?.[0]).toBe(1);
  });

  it("keeps total blob bytes within the 16 KB limit", () => {
    const dataset = spyDataset();
    const metrics = analyticsEngineMetrics(dataset);
    metrics.count("e", { big: "x".repeat(20_000) });
    const blobs = dataset.points[0]?.blobs ?? [];
    const total = blobs.reduce(
      (sum, b) => sum + new TextEncoder().encode(String(b)).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(16_384);
  });

  it("never throws when writeDataPoint throws", () => {
    const dataset: AnalyticsEngineDatasetLike = {
      writeDataPoint: vi.fn(() => {
        throw new Error("AE unavailable");
      }),
    };
    const metrics = analyticsEngineMetrics(dataset);
    expect(() => metrics.count("e", { a: 1 })).not.toThrow();
    expect(() => metrics.observe("e", 2)).not.toThrow();
  });
});
