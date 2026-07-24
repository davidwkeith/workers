import { describe, expect, it } from "vitest";

import { decodeEntities } from "./entities.js";

describe("decodeEntities", () => {
  it("decodes the predefined named entities, case-insensitively", () => {
    expect(
      decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"),
    ).toBe("a & b <c> \"d\" 'e'");
    expect(decodeEntities("&AMP;&LT;")).toBe("&<");
  });

  it("decodes decimal and hex numeric references", () => {
    expect(decodeEntities("&#38;&#x26;&#X26;")).toBe("&&&");
    expect(decodeEntities("&#128512;")).toBe("😀");
  });

  it("leaves unknown or malformed references as written", () => {
    expect(decodeEntities("&bogus; &amp &#xZZ;")).toBe("&bogus; &amp &#xZZ;");
    // Out-of-range and surrogate code points are not decoded.
    expect(decodeEntities("&#x110000; &#xD800;")).toBe("&#x110000; &#xD800;");
  });

  it("returns entity-free input unchanged", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});
