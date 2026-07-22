import { describe, expect, it } from "vitest";

import { sanitizeStatusHtml } from "./sanitize.js";

describe("sanitizeStatusHtml", () => {
  it("keeps allowlisted tags and their href/rel", () => {
    const input =
      '<p>Hello <a href="https://example.com" rel="me">world</a></p>';
    expect(sanitizeStatusHtml(input)).toBe(input);
  });

  it("strips script tags and their content entirely", () => {
    expect(sanitizeStatusHtml("<p>hi</p><script>alert(1)</script>")).toBe(
      "<p>hi</p>",
    );
  });

  it("strips event-handler attributes", () => {
    expect(sanitizeStatusHtml('<a href="/" onclick="evil()">x</a>')).toBe(
      '<a href="/">x</a>',
    );
  });

  it("strips non-allowlisted tags but keeps their text content", () => {
    expect(sanitizeStatusHtml("<div>hi <b>there</b></div>")).toBe(
      "hi <b>there</b>",
    );
  });

  it("drops javascript: URLs", () => {
    expect(sanitizeStatusHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      "<a>x</a>",
    );
  });
});
