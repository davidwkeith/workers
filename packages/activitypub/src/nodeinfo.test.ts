import { describe, expect, it } from "vitest";

import {
  buildNodeInfo20,
  buildNodeInfo21,
  buildNodeInfoDiscovery,
} from "./nodeinfo";

describe("NodeInfo", () => {
  it("the discovery doc points at both the 2.0 and 2.1 documents", () => {
    const doc = buildNodeInfoDiscovery("https://example.com");
    const links = doc.links as { rel: string; href: string }[];
    expect(links).toHaveLength(2);
    expect(links[0]?.rel).toBe(
      "http://nodeinfo.diaspora.software/ns/schema/2.0",
    );
    expect(links[0]?.href).toBe("https://example.com/nodeinfo/2.0");
    expect(links[1]?.rel).toBe(
      "http://nodeinfo.diaspora.software/ns/schema/2.1",
    );
    expect(links[1]?.href).toBe("https://example.com/nodeinfo/2.1");
  });

  it("the 2.1 doc declares activitypub and omits usage without counts", () => {
    const doc = buildNodeInfo21({ name: "dwk", version: "1.0.0" });
    expect(doc.version).toBe("2.1");
    expect(doc.protocols).toEqual(["activitypub"]);
    expect(doc.openRegistrations).toBe(false);
    expect(doc.usage).toBeUndefined();
  });

  it("the 2.0 doc mirrors 2.1 but for the version string", () => {
    const doc = buildNodeInfo20({ name: "dwk", version: "1.0.0" });
    expect(doc.version).toBe("2.0");
    expect(doc.protocols).toEqual(["activitypub"]);
    expect(doc.software).toEqual({ name: "dwk", version: "1.0.0" });
  });

  it("includes usage when counts are supplied", () => {
    const doc = buildNodeInfo21(
      { name: "dwk", version: "1.0.0" },
      { users: 1, localPosts: 7 },
    );
    expect(doc.usage).toEqual({ users: { total: 1 }, localPosts: 7 });
  });
});
