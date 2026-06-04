import { describe, it, expect } from "vitest";
import { parseLinkHeader, scanElements, splitTokens } from "./html";

describe("scanElements", () => {
  it("reports matching elements in document order with requested attributes", async () => {
    const els = await scanElements(
      '<a href="https://x.example/">x</a><link rel="webmention" href="/wm">',
      "a, link",
      ["rel", "href"],
    );
    expect(els).toEqual([
      { name: "a", attrs: { rel: null, href: "https://x.example/" } },
      { name: "link", attrs: { rel: "webmention", href: "/wm" } },
    ]);
  });

  it("does not report elements inside comments", async () => {
    const els = await scanElements(
      '<!-- <a href="/false">x</a> --><a href="/real">y</a>',
      "a",
      ["href"],
    );
    expect(els).toEqual([{ name: "a", attrs: { href: "/real" } }]);
  });

  it('distinguishes an absent attribute (null) from an empty one ("")', async () => {
    const els = await scanElements(
      '<link rel="webmention"><link rel="webmention" href="">',
      "link",
      ["href"],
    );
    expect(els).toEqual([
      { name: "link", attrs: { href: null } },
      { name: "link", attrs: { href: "" } },
    ]);
  });

  it("does not confuse a data- prefixed attribute with the bare name", async () => {
    const els = await scanElements(
      '<a data-href="decoy" href="real">x</a>',
      "a",
      ["href"],
    );
    expect(els).toEqual([{ name: "a", attrs: { href: "real" } }]);
  });

  it("reads unquoted attribute values", async () => {
    const els = await scanElements("<link rel=webmention>", "link", ["rel"]);
    expect(els).toEqual([{ name: "link", attrs: { rel: "webmention" } }]);
  });
});

describe("parseLinkHeader", () => {
  it("does not split on a comma inside a quoted parameter value", () => {
    const entries = parseLinkHeader(
      '<https://x.example/wm>; rel="webmention"; title="My, Receiver"',
    );
    expect(entries).toEqual([
      { uri: "https://x.example/wm", rels: ["webmention"] },
    ]);
  });

  it("splits multiple links", () => {
    const entries = parseLinkHeader(
      '<https://a.example/>; rel="up", <https://b.example/>; rel="webmention"',
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      uri: "https://b.example/",
      rels: ["webmention"],
    });
  });

  it("does not mistake a rel= substring in another quoted param", () => {
    const entries = parseLinkHeader(
      '<https://x.example/wm>; title="my rel=bogus"; rel="webmention"',
    );
    expect(entries).toEqual([
      { uri: "https://x.example/wm", rels: ["webmention"] },
    ]);
  });

  it("drops entries with no rel parameter", () => {
    expect(parseLinkHeader("<https://x.example/>")).toEqual([]);
  });
});

describe("splitTokens", () => {
  it("splits on whitespace and drops empties", () => {
    expect(splitTokens("  me  webmention ")).toEqual(["me", "webmention"]);
    expect(splitTokens(null)).toEqual([]);
  });
});
