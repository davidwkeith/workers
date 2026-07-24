import { describe, expect, it } from "vitest";

import { sanitizeContentHtml } from "./sanitize.js";

describe("sanitizeContentHtml", () => {
  it("returns '' for '' without transforming anything", async () => {
    expect(await sanitizeContentHtml("", "https://x.example/")).toBe("");
  });

  it("keeps allowed inline formatting tags with no attributes", async () => {
    const html = "<p>Hello <em>world</em> <strong>!</strong></p>";
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(html);
  });

  it("keeps a safe absolute http(s) link, resolves a relative one, and forces rel=ugc nofollow", async () => {
    const html =
      '<p>See <a href="https://other.example/post" class="fancy">this</a> and ' +
      '<a href="/local">that</a>.</p>';
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      '<p>See <a href="https://other.example/post" rel="ugc nofollow">this</a> and ' +
        '<a href="https://x.example/local" rel="ugc nofollow">that</a>.</p>',
    );
  });

  it("unwraps a link with a javascript: href, keeping its text", async () => {
    const html = '<p>Click <a href="javascript:alert(1)">here</a>.</p>';
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "<p>Click here.</p>",
    );
  });

  it("unwraps a link with a data: href", async () => {
    const html = '<a href="data:text/html,<script>alert(1)</script>">click</a>';
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe("click");
  });

  it("unwraps a link with no href", async () => {
    const html = "<a>anchor with no href</a>";
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "anchor with no href",
    );
  });

  it("unwraps disallowed elements but keeps their text and allowed descendants", async () => {
    const html =
      '<div class="wrapper"><h2>Title</h2><span>plain <b>bold</b></span></div>';
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "Titleplain <b>bold</b>",
    );
  });

  it("drops images entirely", async () => {
    const html =
      '<p>Look: <img src="https://x.example/cat.png" alt="cat"> nice</p>';
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "<p>Look:  nice</p>",
    );
  });

  it("drops script and style content entirely, not just their tags", async () => {
    const html =
      "<p>Before</p><script>evil();</script><style>body{color:red}</style><p>After</p>";
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "<p>Before</p><p>After</p>",
    );
  });

  it("strips attributes other than a's href", async () => {
    const html = '<p onclick="evil()" style="color:red">text</p>';
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "<p>text</p>",
    );
  });

  it("escapes text content so it can't reintroduce markup", async () => {
    const html = "<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>";
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>",
    );
  });

  it("keeps br as a self-closing void element with no closing tag", async () => {
    const html = "<p>line one<br>line two</p>";
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(
      "<p>line one<br>line two</p>",
    );
  });

  it("keeps nested allowed list markup", async () => {
    const html = "<ul><li>one</li><li>two <em>emphasized</em></li></ul>";
    expect(await sanitizeContentHtml(html, "https://x.example/")).toBe(html);
  });
});
