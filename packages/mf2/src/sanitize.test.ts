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
    // Relative href with no base URL to resolve against.
    expect(await sanitizeHtml('<a href="/rel">x</a>')).toBe("x");
    expect(await sanitizeHtml("<a>x</a>")).toBe("x");
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

  it("returns '' when nothing survives", async () => {
    expect(await sanitizeHtml("")).toBe("");
    expect(await sanitizeHtml("<script>x()</script>")).toBe("");
  });
});
