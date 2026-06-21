import { describe, it, expect, vi } from "vitest";
import { extractLinks, sourceLinksTo, verifySource } from "./verify.js";

const source = "https://blog.example/post";
const target = "https://example.com/article";

describe("extractLinks", () => {
  it("collects href and src links, resolved against the base", async () => {
    const html =
      '<a href="/a">a</a><link rel="x" href="https://x.example/b">' +
      '<img src="img.png"><area href="/c">';
    expect(await extractLinks(html, source)).toEqual([
      "https://blog.example/a",
      "https://x.example/b",
      "https://blog.example/c",
      "https://blog.example/img.png",
    ]);
  });

  it("resolves relative links against a <base href>", async () => {
    const html = '<base href="https://cdn.example/x/"><a href="rel">a</a>';
    expect(await extractLinks(html, source)).toEqual([
      "https://cdn.example/x/rel",
    ]);
  });

  it("ignores links inside HTML comments", async () => {
    const html =
      `<!-- <a href="${target}">commented</a> -->` +
      '<a href="https://kept.example/">real</a>';
    expect(await extractLinks(html, source)).toEqual(["https://kept.example/"]);
  });
});

describe("sourceLinksTo", () => {
  it("is true when an anchor links to the target", async () => {
    const html = `<p>see <a href="${target}">this</a></p>`;
    expect(await sourceLinksTo(html, target, source, "text/html")).toBe(true);
  });

  it("resolves relative links before comparing", async () => {
    const html = '<a href="/article">x</a>';
    expect(
      await sourceLinksTo(
        html,
        "https://blog.example/article",
        source,
        "text/html",
      ),
    ).toBe(true);
  });

  it("is false when the source does not link to the target", async () => {
    const html = '<a href="https://elsewhere.example/">x</a>';
    expect(await sourceLinksTo(html, target, source, "text/html")).toBe(false);
  });

  it("is false when the only link to the target is inside a comment", async () => {
    const html = `<!-- <a href="${target}">x</a> -->`;
    expect(await sourceLinksTo(html, target, source, "text/html")).toBe(false);
  });

  it("matches a standalone target URL token in a plain-text body", async () => {
    expect(
      await sourceLinksTo(`mentions ${target}`, target, source, "text/plain"),
    ).toBe(true);
    // Whitespace on either side is a boundary, including the start/end of line.
    expect(
      await sourceLinksTo(`${target}\nnext line`, target, source, "text/plain"),
    ).toBe(true);
    expect(
      await sourceLinksTo(`re: ${target} thanks`, target, source, "text/plain"),
    ).toBe(true);
    // Trailing sentence punctuation and surrounding brackets are boundaries too.
    expect(
      await sourceLinksTo(`Check out ${target}.`, target, source, "text/plain"),
    ).toBe(true);
    expect(
      await sourceLinksTo(
        `See (${target}), or [${target}]`,
        target,
        source,
        "text/plain",
      ),
    ).toBe(true);
    expect(
      await sourceLinksTo("nothing here", target, source, "text/plain"),
    ).toBe(false);
  });

  it("still rejects a longer URL whose path continues past the target", async () => {
    // A `.`-then-core continuation (a file extension) is not a boundary.
    expect(
      await sourceLinksTo(
        "https://example.com/article.html",
        target,
        source,
        "text/plain",
      ),
    ).toBe(false);
  });

  it("requires a token boundary, not a loose substring, in plain text", async () => {
    // A longer URL containing the target as a prefix must not over-match.
    expect(
      await sourceLinksTo(`${target}/extra`, target, source, "text/plain"),
    ).toBe(false);
    // `…/post` must not match inside `…/posting`.
    expect(
      await sourceLinksTo(
        "https://example.com/posting",
        "https://example.com/post",
        source,
        "text/plain",
      ),
    ).toBe(false);
    // The target as a suffix of a longer URL must not match either.
    expect(
      await sourceLinksTo(
        `https://evil.example/${target}`,
        target,
        source,
        "text/plain",
      ),
    ).toBe(false);
  });

  it("requires an exact target value in a JSON body", async () => {
    const body = JSON.stringify({
      type: "entry",
      refs: ["https://other.example/", target],
    });
    expect(await sourceLinksTo(body, target, source, "application/json")).toBe(
      true,
    );
    // The target merely embedded inside a longer string value must not match.
    const embedded = JSON.stringify({ note: `see ${target}/extra` });
    expect(
      await sourceLinksTo(embedded, target, source, "application/json"),
    ).toBe(false);
    // Honors a `+json` suffix content type too.
    expect(
      await sourceLinksTo(body, target, source, "application/activity+json"),
    ).toBe(true);
  });

  it("is false for an unparseable JSON body", async () => {
    expect(
      await sourceLinksTo(
        `not json ${target}`,
        target,
        source,
        "application/json",
      ),
    ).toBe(false);
  });
});

describe("verifySource", () => {
  it("returns links:true when the fetched source links to the target", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(`<a href="${target}">x</a>`, {
          headers: { "content-type": "text/html" },
        }),
    );
    expect(await verifySource(source, target, { fetch: fetchImpl })).toEqual({
      links: true,
      status: 200,
    });
  });

  it("returns links:false for a 404 source", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 }));
    expect(await verifySource(source, target, { fetch: fetchImpl })).toEqual({
      links: false,
      status: 404,
    });
  });

  it("returns status 0 when the fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await verifySource(source, target, { fetch: fetchImpl })).toEqual({
      links: false,
      status: 0,
    });
  });
});
