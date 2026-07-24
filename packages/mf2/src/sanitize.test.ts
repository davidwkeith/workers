import { describe, expect, it } from "vitest";

import { sanitizeHtml } from "./sanitize.js";

describe("sanitizeHtml", () => {
  it("keeps allowlisted formatting and unwraps everything else", async () => {
    const out = await sanitizeHtml(
      '<div><p>Hello <em>world</em> <span data-x="1">and</span> <strong>more</strong></p></div>',
    );
    expect(out).toBe("<p>Hello <em>world</em> and <strong>more</strong></p>");
  });

  it("drops script/style subtrees entirely, text included", async () => {
    const out = await sanitizeHtml(
      "<p>before</p><script>alert('x')</script><style>p{}</style><p>after</p>",
    );
    expect(out).toBe("<p>before</p><p>after</p>");
  });

  it("strips all attributes except a validated a[href], forcing rel", async () => {
    const out = await sanitizeHtml(
      '<p class="x" onclick="evil()">See <a href="https://a.example/post" target="_blank" onmouseover="evil()">this</a></p>',
    );
    expect(out).toBe(
      '<p>See <a href="https://a.example/post" rel="ugc nofollow">this</a></p>',
    );
  });

  it("unwraps links with unsafe or unresolvable hrefs", async () => {
    expect(await sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("x");
    expect(await sanitizeHtml('<a href="data:text/html,hi">x</a>')).toBe("x");
    // Entity-obfuscated scheme is decoded before validation.
    expect(await sanitizeHtml('<a href="java&#115;cript:alert(1)">x</a>')).toBe(
      "x",
    );
    // Relative href with no base URL to resolve against.
    expect(await sanitizeHtml('<a href="/rel">x</a>')).toBe("x");
    expect(await sanitizeHtml("<a>x</a>")).toBe("x");
  });

  it("round-trips an entity-encoded href without double-escaping", async () => {
    const out = await sanitizeHtml(
      '<a href="https://a.example/?x=1&amp;y=2">x</a>',
    );
    expect(out).toBe(
      '<a href="https://a.example/?x=1&amp;y=2" rel="ugc nofollow">x</a>',
    );
  });

  it("resolves relative hrefs against baseUrl", async () => {
    const out = await sanitizeHtml('<a href="/post/1">x</a>', {
      baseUrl: "https://source.example/reply",
    });
    expect(out).toBe(
      '<a href="https://source.example/post/1" rel="ugc nofollow">x</a>',
    );
  });

  it("passes top-level text with no wrapping tag through", async () => {
    expect(await sanitizeHtml("just plain text")).toBe("just plain text");
    expect(await sanitizeHtml("before <em>mid</em> after")).toBe(
      "before <em>mid</em> after",
    );
  });

  it("preserves entities without double-escaping", async () => {
    expect(await sanitizeHtml("<p>a &amp; b &lt;tag&gt;</p>")).toBe(
      "<p>a &amp; b &lt;tag&gt;</p>",
    );
  });

  it("truncates on text length with an ellipsis, closing open tags", async () => {
    const out = await sanitizeHtml(
      "<p><em>0123456789</em>0123456789</p><p>never</p>",
      { maxTextLength: 15 },
    );
    expect(out).toBe("<p><em>0123456789</em>01234…</p>");
  });

  it("does not sever an entity at the truncation point", async () => {
    const out = await sanitizeHtml("<p>aaaa&amp;bbbb</p>", {
      maxTextLength: 7,
    });
    expect(out).toBe("<p>aaaa…</p>");
  });

  it("does not sever a surrogate pair at the truncation point", async () => {
    // The cap lands between the emoji's two UTF-16 code units.
    const out = await sanitizeHtml("<p>ab😀cd</p>", { maxTextLength: 3 });
    expect(out).toBe("<p>ab…</p>");
  });

  it("closes tags the source leaves unclosed", async () => {
    const out = await sanitizeHtml("<p>one <em>two");
    expect(out).toBe("<p>one <em>two</em></p>");
  });

  it("keeps <br> without a closing tag", async () => {
    expect(await sanitizeHtml("<p>a<br>b</p>")).toBe("<p>a<br>b</p>");
  });

  it("rewrites img to a link labeled by its alt text", async () => {
    const out = await sanitizeHtml(
      '<p>Look: <img src="https://a.example/cat.jpg" alt="A cat" width="800" onerror="evil()"></p>',
    );
    expect(out).toBe(
      '<p>Look: <a href="https://a.example/cat.jpg" rel="ugc nofollow">A cat</a></p>',
    );
  });

  it("labels an alt-less img with its resolved URL", async () => {
    const out = await sanitizeHtml('<img src="/cat.jpg">', {
      baseUrl: "https://source.example/reply",
    });
    expect(out).toBe(
      '<a href="https://source.example/cat.jpg" rel="ugc nofollow">https://source.example/cat.jpg</a>',
    );
  });

  it("keeps only alt text when img src is unsafe or unresolvable", async () => {
    expect(await sanitizeHtml('<img src="javascript:x()" alt="cat">')).toBe(
      "cat",
    );
    // Entity-obfuscated scheme is decoded before validation.
    expect(
      await sanitizeHtml('<img src="java&#115;cript:x()" alt="cat">'),
    ).toBe("cat");
    expect(await sanitizeHtml('<img alt="cat">')).toBe("cat");
    // No safe src and no alt: nothing survives.
    expect(await sanitizeHtml('<img src="/rel">')).toBe("");
  });

  it("drops img inside dropped subtrees", async () => {
    expect(
      await sanitizeHtml(
        '<noscript><img src="https://a.example/cat.jpg" alt="cat"></noscript>',
      ),
    ).toBe("");
  });

  it("re-encodes entity-encoded img attributes without double-escaping", async () => {
    const out = await sanitizeHtml(
      '<img src="https://a.example/?a=1&amp;b=2" alt="a &amp; b">',
    );
    expect(out).toBe(
      '<a href="https://a.example/?a=1&amp;b=2" rel="ugc nofollow">a &amp; b</a>',
    );
  });

  it("counts img labels toward maxTextLength", async () => {
    const out = await sanitizeHtml(
      '<p>abcde<img src="https://a.example/p.jpg" alt="0123456789"></p>',
      { maxTextLength: 10 },
    );
    expect(out).toBe(
      '<p>abcde<a href="https://a.example/p.jpg" rel="ugc nofollow">01234…</a></p>',
    );
  });

  it("demotes headings to bold paragraphs", async () => {
    expect(await sanitizeHtml("<h1>Big</h1><h6>Small</h6>")).toBe(
      "<p><strong>Big</strong></p><p><strong>Small</strong></p>",
    );
  });

  it("preserves inline formatting inside a demoted heading", async () => {
    const out = await sanitizeHtml(
      '<h2>See <em>this</em> <a href="https://a.example/">link</a></h2>',
    );
    expect(out).toBe(
      '<p><strong>See <em>this</em> <a href="https://a.example/" rel="ugc nofollow">link</a></strong></p>',
    );
  });

  it("closes a demoted heading the source leaves unclosed", async () => {
    expect(await sanitizeHtml("<h3>title")).toBe(
      "<p><strong>title</strong></p>",
    );
  });

  it("returns '' when nothing survives", async () => {
    expect(await sanitizeHtml("")).toBe("");
    expect(await sanitizeHtml("<script>x()</script>")).toBe("");
  });
});
