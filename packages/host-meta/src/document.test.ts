import { describe, it, expect } from "vitest";

import { buildDocument, lrddTemplate } from "./index";

describe("lrddTemplate", () => {
  it("appends resource={uri} to a bare WebFinger URL", () => {
    expect(lrddTemplate("https://example.com/.well-known/webfinger")).toBe(
      "https://example.com/.well-known/webfinger?resource={uri}",
    );
  });

  it("appends with & when the URL already has a query string", () => {
    expect(lrddTemplate("https://example.com/wf?v=1")).toBe(
      "https://example.com/wf?v=1&resource={uri}",
    );
  });

  it("uses a URL that already carries a {uri} placeholder verbatim", () => {
    const url = "https://example.com/wf?resource={uri}&rel=self";
    expect(lrddTemplate(url)).toBe(url);
  });
});

describe("buildDocument", () => {
  it("emits the lrdd link first when a WebFinger URL is supplied", () => {
    const doc = buildDocument({
      webfingerUrl: "https://example.com/.well-known/webfinger",
    });
    expect(doc.links).toHaveLength(1);
    expect(doc.links[0]).toEqual({
      rel: "lrdd",
      type: "application/jrd+json",
      template: "https://example.com/.well-known/webfinger?resource={uri}",
    });
  });

  it("appends operator links after the lrdd link", () => {
    const doc = buildDocument({
      webfingerUrl: "https://example.com/.well-known/webfinger",
      links: [{ rel: "author", href: "https://example.com/about" }],
    });
    expect(doc.links).toHaveLength(2);
    expect(doc.links[0]?.rel).toBe("lrdd");
    expect(doc.links[1]?.rel).toBe("author");
  });

  it("works with only operator links and no WebFinger URL", () => {
    const doc = buildDocument({
      links: [{ rel: "license", href: "https://example.com/LICENSE" }],
    });
    expect(doc.links).toHaveLength(1);
    expect(doc.links[0]?.rel).toBe("license");
  });

  it("carries subject and properties through only when supplied", () => {
    const bare = buildDocument({ webfingerUrl: "https://example.com/wf" });
    expect(bare.subject).toBeUndefined();
    expect(bare.properties).toBeUndefined();

    const full = buildDocument({
      webfingerUrl: "https://example.com/wf",
      subject: "https://example.com/",
      properties: { "http://example.com/role": "host" },
    });
    expect(full.subject).toBe("https://example.com/");
    expect(full.properties).toEqual({ "http://example.com/role": "host" });
  });

  it("drops an empty properties object", () => {
    const doc = buildDocument({
      webfingerUrl: "https://example.com/wf",
      properties: {},
    });
    expect(doc.properties).toBeUndefined();
  });
});
