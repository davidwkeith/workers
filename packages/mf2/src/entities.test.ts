import { describe, expect, it } from "vitest";

import { decodeHtmlEntities } from "./entities.js";

describe("decodeHtmlEntities", () => {
  it("returns the input unchanged when there is no &", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
  });

  it("decodes the five named entities", () => {
    expect(decodeHtmlEntities("&amp;&lt;&gt;&quot;&apos;")).toBe(`&<>"'`);
  });

  it("decodes a query string's &amp; back to &", () => {
    expect(decodeHtmlEntities("/x?a=1&amp;b=2")).toBe("/x?a=1&b=2");
  });

  it("decodes decimal and hex numeric character references", () => {
    expect(decodeHtmlEntities("&#65;&#x42;")).toBe("AB");
  });

  it("leaves an unrecognized named entity as-is", () => {
    expect(decodeHtmlEntities("caf&eacute;")).toBe("caf&eacute;");
  });

  it("leaves a bare & with no entity syntax as-is", () => {
    expect(decodeHtmlEntities("Q&A")).toBe("Q&A");
  });
});
