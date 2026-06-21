import { describe, expect, it } from "vitest";

import { parseHFeed } from "./hfeed.js";

describe("parseHFeed", () => {
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
    const entries = await parseHFeed(html, "https://author.example/");
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
      await parseHFeed("<p>nothing here</p>", "https://x.example/"),
    ).toEqual([]);
    expect(await parseHFeed("", "https://x.example/")).toEqual([]);
  });

  it("falls back to a hashed id when an entry has no url", async () => {
    const html = `<div class="h-entry"><p class="p-name">No link</p></div>`;
    const [entry] = await parseHFeed(html, "https://x.example/");
    expect(entry?.url).toBeUndefined();
    expect(entry?._id).toBeTruthy();
  });
});
