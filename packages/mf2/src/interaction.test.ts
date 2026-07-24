import { describe, expect, it } from "vitest";

import { matchInteraction } from "./interaction.js";
import { parseHFeed } from "./hfeed.js";

const TARGET = "https://my.site/posts/hello";

describe("matchInteraction", () => {
  it("returns null when no entry targets the URL", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-url" href="https://x.example/1"></a></article>`,
      "https://x.example/",
    );
    expect(matchInteraction(entries, TARGET)).toBeNull();
  });

  it("returns null for an empty entry list", () => {
    expect(matchInteraction([], TARGET)).toBeNull();
  });

  it("matches a reply", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-in-reply-to" href="${TARGET}"></a></article>`,
      "https://x.example/",
    );
    const match = matchInteraction(entries, TARGET);
    expect(match?.kind).toBe("reply");
  });

  it("matches a repost", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-repost-of" href="${TARGET}"></a></article>`,
      "https://x.example/",
    );
    expect(matchInteraction(entries, TARGET)?.kind).toBe("repost");
  });

  it("matches a like", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-like-of" href="${TARGET}"></a></article>`,
      "https://x.example/",
    );
    expect(matchInteraction(entries, TARGET)?.kind).toBe("like");
  });

  it("matches a bookmark", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-bookmark-of" href="${TARGET}"></a></article>`,
      "https://x.example/",
    );
    expect(matchInteraction(entries, TARGET)?.kind).toBe("bookmark");
  });

  it("prefers the entry that targets the URL over one that doesn't, regardless of order", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-like-of" href="https://elsewhere.example/"></a></article>
       <article class="h-entry"><a class="u-bookmark-of" href="${TARGET}"></a></article>`,
      "https://x.example/",
    );
    expect(matchInteraction(entries, TARGET)?.kind).toBe("bookmark");
  });

  it("precedence: reply beats repost/like/bookmark on the same entry", async () => {
    const html = `<article class="h-entry">
      <a class="u-in-reply-to" href="${TARGET}"></a>
      <a class="u-like-of" href="${TARGET}"></a>
    </article>`;
    const entries = await parseHFeed(html, "https://x.example/");
    expect(matchInteraction(entries, TARGET)?.kind).toBe("reply");
  });

  it("requires an exact absolute-URL match (no trailing-slash fuzzing)", async () => {
    const entries = await parseHFeed(
      `<article class="h-entry"><a class="u-like-of" href="${TARGET}"></a></article>`,
      "https://x.example/",
    );
    expect(matchInteraction(entries, `${TARGET}/`)).toBeNull();
    expect(matchInteraction(entries, TARGET)?.kind).toBe("like");
  });
});
