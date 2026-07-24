import { describe, expect, it } from "vitest";

import { parseHEntries } from "./hentry.js";

describe("parseHEntries", () => {
  it("extracts h-entry properties with a nested author h-card", async () => {
    const html = `
      <div class="h-feed">
        <article class="h-entry">
          <h1 class="p-name">Hello World</h1>
          <a class="u-url" href="/post/1">permalink</a>
          <time class="dt-published" datetime="2026-03-01T10:00:00Z">Mar 1</time>
          <div class="e-content">Body <em>text</em> here</div>
          <a class="p-category" href="/t/x">x</a>
          <span class="p-category">y</span>
          <div class="p-author h-card">
            <a class="u-url" href="https://author.example/">
              <span class="p-name">The Author</span>
            </a>
            <img class="u-photo" src="/avatar.png"/>
          </div>
        </article>
        <article class="h-entry">
          <a class="u-like-of" href="https://liked.example/post"></a>
          <a class="u-in-reply-to" href="https://reply.example/post"></a>
        </article>
      </div>`;
    const entries = await parseHEntries(html, "https://author.example/");
    expect(entries).toHaveLength(2);

    const [first, second] = entries;
    expect(first?.name).toBe("Hello World");
    expect(first?.url).toBe("https://author.example/post/1");
    expect(first?.published).toBe("2026-03-01T10:00:00Z");
    expect(first?.content?.text).toContain("Body");
    expect(first?.category).toEqual(["x", "y"]);
    expect(first?.author?.name).toBe("The Author");
    expect(first?.author?.url).toBe("https://author.example/");
    expect(first?.author?.photo).toBe("https://author.example/avatar.png");

    // The second entry is a like + reply with no name; it still gets an id.
    expect(second?._id).toBeTruthy();
    expect(second?.["like-of"]).toBe("https://liked.example/post");
    expect(second?.["in-reply-to"]).toBe("https://reply.example/post");
  });

  it("returns [] when there is no h-entry", async () => {
    expect(
      await parseHEntries("<p>nothing here</p>", "https://x.example/"),
    ).toEqual([]);
    expect(await parseHEntries("", "https://x.example/")).toEqual([]);
  });

  it("falls back to a hashed id when an entry has no url", async () => {
    const html = `<div class="h-entry"><p class="p-name">No link</p></div>`;
    const [entry] = await parseHEntries(html, "https://x.example/");
    expect(entry?.url).toBeUndefined();
    expect(entry?._id).toBeTruthy();
  });

  it("extracts u-repost-of and u-bookmark-of, resolved against the base", async () => {
    const html = `
      <div class="h-entry">
        <a class="u-repost-of" href="/reposted">repost</a>
      </div>
      <div class="h-entry">
        <a class="u-bookmark-of" href="https://bookmarked.example/post">bm</a>
      </div>`;
    const [repost, bookmark] = await parseHEntries(
      html,
      "https://source.example/",
    );
    expect(repost?.["repost-of"]).toBe("https://source.example/reposted");
    expect(bookmark?.["bookmark-of"]).toBe("https://bookmarked.example/post");
  });

  it("captures e-content inner HTML alongside the text", async () => {
    const html = `
      <div class="h-entry">
        <div class="e-content"><p>Nice <em>post</em> &amp; thanks!</p><img src="/pic.png"></div>
      </div>`;
    const [entry] = await parseHEntries(html, "https://x.example/");
    // Plain-text properties are entity-decoded; the HTML capture stays
    // encoded as written.
    expect(entry?.content?.text).toBe("Nice post & thanks!");
    expect(entry?.content?.html).toBe(
      '<p>Nice <em>post</em> &amp; thanks!</p><img src="/pic.png">',
    );
  });

  it("decodes entities in attribute-valued and text-valued properties", async () => {
    const html = `
      <div class="h-entry">
        <a class="u-in-reply-to" href="https://t.example/?a=1&amp;b=2">re</a>
        <p class="p-name">O&#39;Brien &amp; friends</p>
      </div>`;
    const [entry] = await parseHEntries(html, "https://x.example/");
    expect(entry?.["in-reply-to"]).toBe("https://t.example/?a=1&b=2");
    expect(entry?.name).toBe("O'Brien & friends");
  });

  it("does not double-escape raw attribute values in the HTML capture", async () => {
    const html =
      `<div class="h-entry"><div class="e-content">` +
      `<a href="https://t.example/?a=1&amp;b=2">x</a></div></div>`;
    const [entry] = await parseHEntries(html, "https://x.example/");
    expect(entry?.content?.html).toBe(
      '<a href="https://t.example/?a=1&amp;b=2">x</a>',
    );
  });

  it("keeps the first e-content and does not leak markup across entries", async () => {
    const html = `
      <div class="h-entry">
        <div class="e-content">first</div>
        <div class="e-content"><b>second</b></div>
      </div>
      <div class="h-entry">
        <div class="e-content">other entry</div>
      </div>`;
    const [first, second] = await parseHEntries(html, "https://x.example/");
    expect(first?.content?.text).toBe("first");
    expect(first?.content?.html).toBe("first");
    expect(second?.content?.text).toBe("other entry");
    expect(second?.content?.html).toBe("other entry");
  });
});
