import { describe, expect, it } from "vitest";

import { extractEnrichment, isInteractionType } from "./enrich.js";

const base = "https://source.example/post";
const target = "https://example.com/article";

describe("extractEnrichment", () => {
  it("classifies a reply and captures author, content, and published", async () => {
    const html = `
      <article class="h-entry">
        <a class="u-in-reply-to" href="${target}">in reply to</a>
        <time class="dt-published" datetime="2026-07-01T10:00:00Z">Jul 1</time>
        <div class="e-content"><p>Totally <strong>agree</strong>.</p></div>
        <div class="p-author h-card">
          <a class="u-url" href="/"><span class="p-name">Replier</span></a>
        </div>
      </article>`;
    expect(await extractEnrichment(html, base, target)).toEqual({
      interactionType: "reply",
      author: { name: "Replier", url: "https://source.example/" },
      content: "<p>Totally <strong>agree</strong>.</p>",
      published: "2026-07-01T10:00:00Z",
    });
  });

  it("classifies likes, reposts, and bookmarks", async () => {
    const cases = [
      ["u-like-of", "like"],
      ["u-repost-of", "repost"],
      ["u-bookmark-of", "bookmark"],
    ] as const;
    for (const [cls, type] of cases) {
      const html = `<div class="h-entry"><a class="${cls}" href="${target}">x</a></div>`;
      expect(
        (await extractEnrichment(html, base, target)).interactionType,
      ).toBe(type);
    }
  });

  it("applies reply > repost > like > bookmark precedence within one entry", async () => {
    const html = `
      <div class="h-entry">
        <a class="u-bookmark-of" href="${target}">b</a>
        <a class="u-like-of" href="${target}">l</a>
        <a class="u-repost-of" href="${target}">r</a>
        <a class="u-in-reply-to" href="${target}">re</a>
      </div>`;
    expect((await extractEnrichment(html, base, target)).interactionType).toBe(
      "reply",
    );
    const noReply = `
      <div class="h-entry">
        <a class="u-bookmark-of" href="${target}">b</a>
        <a class="u-repost-of" href="${target}">r</a>
      </div>`;
    expect(
      (await extractEnrichment(noReply, base, target)).interactionType,
    ).toBe("repost");
  });

  it("scopes enrichment to the entry responding to *our* target", async () => {
    // The first entry replies to someone else; only the second likes us.
    const html = `
      <div class="h-entry">
        <a class="u-in-reply-to" href="https://other.example/">other</a>
        <div class="e-content">not about us</div>
      </div>
      <div class="h-entry">
        <a class="u-like-of" href="${target}">like</a>
        <div class="e-content">about us</div>
      </div>`;
    const enrichment = await extractEnrichment(html, base, target);
    expect(enrichment.interactionType).toBe("like");
    expect(enrichment.content).toBe("about us");
  });

  it("treats a bare link (no responding h-entry) as a plain mention", async () => {
    const html = `
      <p>Interesting: <a href="${target}">read this</a></p>
      <div class="h-entry">
        <a class="u-in-reply-to" href="https://unrelated.example/">x</a>
        <div class="e-content">unrelated entry on the same page</div>
        <div class="p-author h-card"><span class="p-name">Someone</span></div>
      </div>`;
    // Author/content are omitted, not guessed from the unrelated entry.
    expect(await extractEnrichment(html, base, target)).toEqual({
      interactionType: "mention",
    });
  });

  it("resolves relative response URLs against the base before matching", async () => {
    const html = `<div class="h-entry"><a class="u-in-reply-to" href="/article">x</a></div>`;
    const enrichment = await extractEnrichment(
      html,
      "https://example.com/reply",
      target,
    );
    expect(enrichment.interactionType).toBe("reply");
  });

  it("sanitizes content: strips scripts/attributes and forces rel on links", async () => {
    const html = `
      <div class="h-entry">
        <a class="u-in-reply-to" href="${target}">re</a>
        <div class="e-content">
          <p onclick="evil()">See <a href="/spam" target="_blank">my site</a></p>
          <script>steal()</script>
        </div>
      </div>`;
    const enrichment = await extractEnrichment(html, base, target);
    expect(enrichment.content).toBe(
      '<p>See <a href="https://source.example/spam" rel="ugc nofollow">my site</a></p>',
    );
  });

  it("truncates long content", async () => {
    const html =
      `<div class="h-entry"><a class="u-in-reply-to" href="${target}">re</a>` +
      `<div class="e-content">${"a".repeat(600)}</div></div>`;
    const enrichment = await extractEnrichment(html, base, target);
    expect(enrichment.content).toBe(`${"a".repeat(500)}…`);
  });
});

describe("isInteractionType", () => {
  it("recognizes the closed set", () => {
    for (const value of ["reply", "like", "repost", "bookmark", "mention"]) {
      expect(isInteractionType(value)).toBe(true);
    }
    expect(isInteractionType("boost")).toBe(false);
  });
});
