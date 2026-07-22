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

  // Regression coverage for a Critical XSS sanitizer bypass: `/` is a valid
  // attribute separator per WHATWG HTML5 tokenization (and a known
  // XSS-filter-evasion technique), not just the self-closing marker. Before
  // the fix, TAG_RE required literal whitespace before every attribute name,
  // so a `/`-separated tag failed to match at all and fell through to the
  // output completely unmodified — bypassing the tag allowlist,
  // event-handler stripping, and `javascript:` URL rejection at once.
  describe("`/` as attribute separator (tokenizer bypass)", () => {
    it("strips a non-allowlisted tag using `/` before its first attribute", () => {
      expect(sanitizeStatusHtml("<img/src=x onerror=alert(1)>")).toBe("");
    });

    it("strips svg using `/` before its first attribute", () => {
      expect(sanitizeStatusHtml("<svg/onload=alert(1)>")).toBe("");
    });

    it("recognizes an `/`-separated allowlisted tag and rejects its javascript: href", () => {
      expect(sanitizeStatusHtml('<a/href="javascript:alert(1)">x</a>')).toBe(
        "<a>x</a>",
      );
    });

    it("still self-closes <br/> correctly (no regression)", () => {
      expect(sanitizeStatusHtml("<p>a<br/>b</p>")).toBe("<p>a<br />b</p>");
    });

    it("still keeps a normal space-separated <a href> (no regression)", () => {
      const input = '<a href="https://example.com">text</a>';
      expect(sanitizeStatusHtml(input)).toBe(input);
    });

    it("handles `/` followed by whitespace before the attribute", () => {
      expect(sanitizeStatusHtml('<a/ href="javascript:alert(1)">x</a>')).toBe(
        "<a>x</a>",
      );
    });

    it("handles a doubled `/` separator", () => {
      expect(sanitizeStatusHtml('<a//href="javascript:alert(1)">x</a>')).toBe(
        "<a>x</a>",
      );
    });

    it("handles multiple attributes after a `/`-separated first one", () => {
      expect(
        sanitizeStatusHtml('<a/href="/" onclick="evil()" rel="me">x</a>'),
      ).toBe('<a href="/" rel="me">x</a>');
    });
  });

  // Regression coverage for a Critical ReDoS: THIS EXACT FIX (widening the
  // attribute separator to `[\s/]+`) made it overlap with the unquoted
  // attribute-value class `[^\s>]*` — both match `/` — so the old combined
  // tag regex could backtrack through exponentially many ways to split a
  // run of `/` characters between "end of value" and "start of separator"
  // whenever a tag never reached a terminating `>`. Fixed by tokenizing the
  // tag body with a monotonic-cursor loop (`scanTagBody` + sticky
  // `ATTR_TOKEN_RE`/`TAG_CLOSE_RE`) instead of one regex with a repeated,
  // ambiguous group. A payload that used to hang for seconds must now
  // resolve well within a generous bound.
  describe("ReDoS resistance (ambiguous separator/value backtracking)", () => {
    it("sanitizes a large adversarial unterminated tag in bounded time", () => {
      const payload = "<a " + "a=/".repeat(500);
      const start = performance.now();
      sanitizeStatusHtml(payload);
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it("still sanitizes the originally-reported hang size (repeat=25)", () => {
      const payload = "<a " + "a=/".repeat(25);
      const start = performance.now();
      expect(sanitizeStatusHtml(payload)).toBe(payload);
      expect(performance.now() - start).toBeLessThan(1000);
    });
  });

  // Regression coverage for an unclosed <script>/<style> leaking its raw
  // body text: before the fix, the `if (closeMatch)` guard skipped advancing
  // the cursor when no closing tag was found anywhere in the remainder, so
  // the opening tag was stripped but its body fell through as plain text on
  // the next loop iteration(s).
  describe("unclosed <script>/<style> (content-leak bypass)", () => {
    it("drops everything after an unclosed <script> with no closing tag", () => {
      expect(
        sanitizeStatusHtml("<script>evil() /* no closing tag at all"),
      ).toBe("");
    });

    it("drops everything after an unclosed <style> with no closing tag", () => {
      expect(sanitizeStatusHtml("<style>body{color:red} no close")).toBe("");
    });

    it("still drops a properly closed <script> and keeps trailing text", () => {
      expect(
        sanitizeStatusHtml("<p>hi</p><script>evil()</script><p>bye</p>"),
      ).toBe("<p>hi</p><p>bye</p>");
    });
  });
});
