import { describe, it, expect } from "vitest";

import { resolveConfig } from "./config.js";
import type { ResourceRecord } from "./jrd.js";

describe("resolveConfig", () => {
  it("throws when neither a resource map nor a resolver is configured", () => {
    expect(() => resolveConfig({})).toThrow(/at least one resource source/);
  });

  it("accepts a config with only a static resource map", () => {
    expect(() => resolveConfig({ resources: {} })).not.toThrow();
  });

  it("accepts a config with only a resolver", () => {
    expect(() =>
      resolveConfig({ resolve: async () => undefined }),
    ).not.toThrow();
  });

  it("resolves an exact match from the static map", async () => {
    const record: ResourceRecord = { links: [{ rel: "self" }] };
    const { resolve } = resolveConfig({
      resources: { "acct:alice@example.com": record },
    });
    expect(await resolve("acct:alice@example.com", [])).toBe(record);
  });

  it("returns undefined for a resource not in the map and with no resolver", async () => {
    const { resolve } = resolveConfig({ resources: {} });
    expect(await resolve("acct:nobody@example.com", [])).toBeUndefined();
  });

  it("consults the static map before the dynamic resolver", async () => {
    const mapped: ResourceRecord = { subject: "from-map", links: [] };
    let resolverCalls = 0;
    const { resolve } = resolveConfig({
      resources: { "acct:alice@example.com": mapped },
      resolve: async () => {
        resolverCalls++;
        return { subject: "from-resolver", links: [] };
      },
    });
    expect(await resolve("acct:alice@example.com", [])).toBe(mapped);
    expect(resolverCalls).toBe(0);
  });

  it("falls back to the resolver when the map has no entry, passing rels", async () => {
    const seen: string[][] = [];
    const { resolve } = resolveConfig({
      resources: {},
      resolve: async (resource, rels) => {
        seen.push([...rels]);
        return resource === "acct:bob@example.com"
          ? { links: [{ rel: "self" }] }
          : undefined;
      },
    });
    const record = await resolve("acct:bob@example.com", ["self"]);
    expect(record?.links).toEqual([{ rel: "self" }]);
    expect(seen).toEqual([["self"]]);
    expect(await resolve("acct:nobody@example.com", [])).toBeUndefined();
  });
});
