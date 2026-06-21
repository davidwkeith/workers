import { describe, it, expect } from "vitest";

import { serializeXrd, escapeXml, XRD_NAMESPACE } from "./index.js";

describe("escapeXml", () => {
  it("escapes the five predefined XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("serializeXrd", () => {
  it("emits the XML declaration and the XRD namespace", () => {
    const xml = serializeXrd({ links: [{ rel: "lrdd", template: "x" }] });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<XRD xmlns="${XRD_NAMESPACE}">`);
    expect(xml.endsWith("</XRD>\n")).toBe(true);
  });

  it("renders a self-closing Link with rel/type/template attributes", () => {
    const xml = serializeXrd({
      links: [
        {
          rel: "lrdd",
          type: "application/jrd+json",
          template: "https://example.com/wf?resource={uri}",
        },
      ],
    });
    expect(xml).toContain(
      '<Link rel="lrdd" type="application/jrd+json" template="https://example.com/wf?resource={uri}"/>',
    );
  });

  it("renders an href Link", () => {
    const xml = serializeXrd({
      links: [{ rel: "author", href: "https://example.com/about" }],
    });
    expect(xml).toContain(
      '<Link rel="author" href="https://example.com/about"/>',
    );
  });

  it("renders a Subject when present", () => {
    const xml = serializeXrd({
      subject: "https://example.com/",
      links: [{ rel: "lrdd", template: "x" }],
    });
    expect(xml).toContain("<Subject>https://example.com/</Subject>");
  });

  it("renders top-level Property values and xsi:nil for null", () => {
    const xml = serializeXrd({
      properties: {
        "http://example.com/role": "host",
        "http://example.com/absent": null,
      },
      links: [{ rel: "lrdd", template: "x" }],
    });
    expect(xml).toContain(
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    );
    expect(xml).toContain(
      '<Property type="http://example.com/role">host</Property>',
    );
    expect(xml).toContain(
      '<Property type="http://example.com/absent" xsi:nil="true"/>',
    );
  });

  it("does not declare the xsi namespace when there are no null properties", () => {
    const xml = serializeXrd({
      properties: { "http://example.com/role": "host" },
      links: [{ rel: "lrdd", template: "x" }],
    });
    expect(xml).not.toContain("xmlns:xsi");
  });

  it("nests Title and Property children inside a Link", () => {
    const xml = serializeXrd({
      links: [
        {
          rel: "author",
          href: "https://example.com/about",
          titles: { en: "About", und: "About (any)" },
          properties: { "http://example.com/x": "y" },
        },
      ],
    });
    expect(xml).toContain('<Title xml:lang="en">About</Title>');
    expect(xml).toContain("<Title>About (any)</Title>");
    expect(xml).toContain('<Property type="http://example.com/x">y</Property>');
    expect(xml).toContain("</Link>");
  });

  it("does not crash when a link's properties bag is a runtime null", () => {
    // Untyped (JS) callers can pass `properties: null`; needsXsi must treat it
    // as "no properties" rather than calling Object.values(null).
    const xml = serializeXrd({
      links: [
        {
          rel: "self",
          href: "https://example.com/",
          properties: null,
        } as never,
      ],
    });
    expect(xml).toContain('<Link rel="self" href="https://example.com/"/>');
    expect(xml).not.toContain("xmlns:xsi");
  });

  it("escapes attribute and text content", () => {
    const xml = serializeXrd({
      subject: "https://example.com/?a=1&b=2",
      links: [{ rel: "self", href: "https://example.com/?x=<1>&y=2" }],
    });
    expect(xml).toContain("https://example.com/?a=1&amp;b=2");
    expect(xml).toContain('href="https://example.com/?x=&lt;1&gt;&amp;y=2"');
  });
});
