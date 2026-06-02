import { describe, it, expect } from "vitest";
import {
  getAttr,
  parseLinkHeader,
  resolveDocumentBase,
  splitTokens,
  stripComments,
} from "./html";

describe("stripComments", () => {
  it("removes single and multi-line HTML comments", () => {
    expect(stripComments("a<!-- x -->b")).toBe("ab");
    expect(stripComments("a<!--\nmulti\nline\n-->b")).toBe("ab");
  });

  it("leaves markup without comments untouched", () => {
    expect(stripComments("<a href='x'>y</a>")).toBe("<a href='x'>y</a>");
  });
});

describe("getAttr", () => {
  it("reads a quoted attribute value", () => {
    expect(getAttr('<a href="https://x.example/">', "href")).toBe(
      "https://x.example/",
    );
  });

  it("does not match a different attribute that ends with the name", () => {
    // `href` must not match `data-href`.
    expect(getAttr('<a data-href="foo" href="bar">', "href")).toBe("bar");
    expect(getAttr('<a data-href="foo">', "href")).toBeNull();
  });

  it("reads an unquoted value", () => {
    expect(getAttr("<link rel=webmention>", "rel")).toBe("webmention");
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

describe("resolveDocumentBase", () => {
  it("returns the document URL when there is no <base>", () => {
    expect(resolveDocumentBase("<p>hi</p>", "https://x.example/a/b")).toBe(
      "https://x.example/a/b",
    );
  });

  it("resolves a relative <base href> against the document URL", () => {
    expect(
      resolveDocumentBase('<base href="/root/">', "https://x.example/a/b"),
    ).toBe("https://x.example/root/");
  });

  it("uses an absolute <base href>", () => {
    expect(
      resolveDocumentBase(
        '<base href="https://cdn.example/">',
        "https://x.example/a/b",
      ),
    ).toBe("https://cdn.example/");
  });
});
