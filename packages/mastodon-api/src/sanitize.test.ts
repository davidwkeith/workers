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

    // This payload is unparseable (never reaches a `>`), so under the
    // fail-safe design its leading `<` is escaped rather than passed
    // through raw — unlike the old fail-open fallback, which left it
    // byte-for-byte unmodified. See the fail-safe-architecture describe
    // block below for why "escaped, not raw" is now the required outcome.
    it("still sanitizes the originally-reported hang size (repeat=25)", () => {
      const payload = "<a " + "a=/".repeat(25);
      const start = performance.now();
      expect(sanitizeStatusHtml(payload)).toBe("&lt;" + payload.slice(1));
      expect(performance.now() - start).toBeLessThan(1000);
    });
  });

  // Regression coverage for a Critical O(n²) DoS: when `scanTagBody` failed
  // to parse a candidate tag, the outer loop resumed scanning from just
  // past the failed tag's *name* rather than past the (much larger) region
  // `scanTagBody` had already walked internally. For a chain of malformed,
  // unterminated tags, each failed attempt's internal attribute-value walk
  // greedily consumed all the way to the end of the string (nothing
  // stopped it at a `<`), and then the *next* failed attempt repeated that
  // same walk from one tag closer to the end — O(n) work, O(n) times.
  // Fixed by excluding `<` from every attribute-value character class in
  // `ATTR_TOKEN_RE`, so a failing walk can never read past the next `<`;
  // combined with the fail-safe fallback advancing exactly one character
  // past a failed candidate, no span of the input is ever walked by more
  // than one `scanTagBody` call. See the complexity comment above
  // `sanitizeStatusHtml` for the full argument.
  describe("O(n²) DoS resistance (chained unterminated tags)", () => {
    it("sanitizes a large chain of malformed tags in near-linear time", () => {
      // Doubling the input must not ~quadruple the time (which is what an
      // O(n²) implementation would do); a generous absolute bound catches
      // both a regression to quadratic behavior and any other blowup.
      const small = ("<a x=" + "y".repeat(20)).repeat(8000);
      const large = ("<a x=" + "y".repeat(20)).repeat(16000);

      const t0 = performance.now();
      sanitizeStatusHtml(small);
      const smallElapsed = performance.now() - t0;

      const t1 = performance.now();
      sanitizeStatusHtml(large);
      const largeElapsed = performance.now() - t1;

      expect(smallElapsed).toBeLessThan(2000);
      expect(largeElapsed).toBeLessThan(2000);
      // Quadratic growth would show up as roughly a 4x jump for a 2x input;
      // allow generous headroom above linear (2x) to avoid CI flakiness
      // while still catching a real O(n²) regression.
      expect(largeElapsed).toBeLessThan(Math.max(smallElapsed * 3, 200));
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

  // Regression coverage for a Critical XSS bypass that survived two prior
  // fix rounds: a tag with NO separator between two attributes (e.g.
  // `onclick="evil()"` glued directly onto a preceding quoted value with no
  // intervening whitespace or `/`) doesn't match this tokenizer's grammar —
  // `scanTagBody` can't find a reachable `>` — and the *fallback* behavior
  // for "couldn't parse this as a tag" used to be "copy the raw bytes
  // through unmodified", so `onclick="evil()"` survived as live, unescaped
  // HTML. The architectural fix makes the fallback fail-SAFE: an
  // unparseable candidate has its leading `<` escaped to `&lt;` instead,
  // which demotes the entire construct to inert text — the browser never
  // parses a real `<a ...>` element out of it, so no attribute (event
  // handler or otherwise) is ever live. This holds regardless of *why*
  // parsing failed, which is what makes it safe against gaps this
  // hand-rolled grammar hasn't been taught about yet, not just this one.
  describe("fail-safe fallback on unparseable tag-shaped input (no separator between attributes)", () => {
    it("neutralizes a live onclick glued directly onto a preceding attribute (no separator)", () => {
      const out = sanitizeStatusHtml('<a href="/"onclick="evil()">nosep</a>');
      expect(out).toBe('&lt;a href="/"onclick="evil()">nosep</a>');
      // No real `<a ...>` element with a live onclick can be parsed out of
      // this: the only unescaped `<` left in the output is the `</a>`
      // closing tag, so there is no unescaped `<` anywhere that opens an
      // element carrying onclick.
      expect(out).not.toMatch(/<[a-z][^>]*\bonclick=/i);
    });

    it("neutralizes a live onerror glued directly onto a preceding attribute (no separator)", () => {
      const out = sanitizeStatusHtml('<img src="x"onerror="alert(1)">');
      expect(out).toBe('&lt;img src="x"onerror="alert(1)">');
      expect(out).not.toMatch(/<[a-z][^>]*\bonerror=/i);
    });

    it("neutralizes a live onclick on an allowlisted tag glued onto a preceding attribute", () => {
      const out = sanitizeStatusHtml(
        '<span class="c"onclick="evil()">t</span>',
      );
      expect(out).toBe('&lt;span class="c"onclick="evil()">t</span>');
      expect(out).not.toMatch(/<[a-z][^>]*\bonclick=/i);
    });
  });

  // A bare `<` that never even attempts a tag shape (no letter, optionally
  // preceded by `/`, immediately after it) used to fall entirely outside
  // the tag-tokenizing loop and reach the output raw. Under the fail-safe
  // design every `<` is accounted for: it either starts a recognized tag or
  // is escaped, so this is now `&lt;` too — strictly safer than before, and
  // no prior test asserted the old raw-passthrough behavior for this case.
  it("escapes a bare `<` in text that never attempts a tag shape", () => {
    expect(sanitizeStatusHtml("a < b")).toBe("a &lt; b");
  });
});
