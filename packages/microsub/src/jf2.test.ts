import { describe, expect, it } from "vitest";

import { parseFeed, type Jf2Entry } from "./jf2";
import {
  child,
  childText,
  children,
  decodeEntities,
  parseXml,
  text,
} from "./xml";

describe("xml reader", () => {
  it("parses elements, attributes, and nested text", () => {
    const root = parseXml(
      `<feed><title>Hi</title><entry id="1">x</entry></feed>`,
    );
    expect(root?.name).toBe("feed");
    expect(childText(root!, "title")).toBe("Hi");
    const entry = child(root!, "entry");
    expect(entry?.attrs.id).toBe("1");
    expect(text(entry)).toBe("x");
  });

  it("handles CDATA, comments, declarations, and self-closing tags", () => {
    const root = parseXml(
      `<?xml version="1.0"?><!DOCTYPE rss><rss><!-- skip --><item>` +
        `<title><![CDATA[A & B]]></title><link/></item></rss>`,
    );
    const item = child(root!, "item");
    expect(childText(item!, "title")).toBe("A & B");
    expect(children(item!, "link")).toHaveLength(1);
  });

  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42;")).toBe(
      "a & b <c> A B",
    );
    // Unknown entities are left intact.
    expect(decodeEntities("&unknown;")).toBe("&unknown;");
  });

  it("lowercases names so namespaced tags match case-insensitively", () => {
    const root = parseXml(
      `<RSS><Channel><Item><DC:Creator>Jo</DC:Creator></Item></Channel></RSS>`,
    );
    const item = child(child(root!, "channel")!, "item");
    expect(childText(item!, "dc:creator")).toBe("Jo");
  });

  it("returns null when there is no element", () => {
    expect(parseXml("just text")).toBeNull();
  });
});

describe("parseFeed — JSON Feed", () => {
  const body = JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "Blog",
    authors: [
      {
        name: "Alice",
        url: "https://alice.example",
        avatar: "https://alice.example/a.png",
      },
    ],
    items: [
      {
        id: "1",
        url: "/post/1",
        title: "First",
        content_html: "<p>Hello</p>",
        summary: "sum",
        date_published: "2026-01-01T00:00:00Z",
        tags: ["a", "b"],
        image: "/img.png",
      },
      { content_text: "no id here" },
    ],
  });

  it("maps items to JF2 entries with resolved URLs and authors", () => {
    const entries = parseFeed(
      body,
      "application/feed+json",
      "https://alice.example/",
    );
    expect(entries).toHaveLength(2);
    const [first, second] = entries as [Jf2Entry, Jf2Entry];
    expect(first._id).toBe("1");
    expect(first.url).toBe("https://alice.example/post/1");
    expect(first.name).toBe("First");
    expect(first.content).toEqual({ html: "<p>Hello</p>" });
    expect(first.author?.name).toBe("Alice");
    expect(first.category).toEqual(["a", "b"]);
    expect(first.photo).toEqual(["https://alice.example/img.png"]);
    // An item without an id falls back to a content hash and inherits the feed author.
    expect(second._id).toBeTruthy();
    expect(second.author?.name).toBe("Alice");
  });

  it("sniffs JSON Feed even without an explicit content type", () => {
    const entries = parseFeed(body, "text/plain", "https://alice.example/");
    expect(entries).toHaveLength(2);
  });

  it("returns [] for malformed JSON", () => {
    expect(
      parseFeed("{not json", "application/json", "https://x.example/"),
    ).toEqual([]);
  });
});

describe("parseFeed — Atom", () => {
  const body = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Site</title>
      <author><name>Bob</name><uri>https://bob.example/</uri></author>
      <entry>
        <title>Post A</title>
        <link rel="alternate" href="https://bob.example/a"/>
        <link rel="edit" href="https://bob.example/a/edit"/>
        <id>urn:a</id>
        <published>2026-02-01T00:00:00Z</published>
        <content type="html">&lt;p&gt;body&lt;/p&gt;</content>
        <category term="tech"/>
      </entry>
      <entry>
        <title>Post B</title>
        <link href="https://bob.example/b"/>
        <updated>2026-02-02T00:00:00Z</updated>
        <summary>just a summary</summary>
      </entry>
    </feed>`;

  it("maps entries, preferring rel=alternate links and inheriting the feed author", () => {
    const entries = parseFeed(
      body,
      "application/atom+xml",
      "https://bob.example/",
    );
    expect(entries).toHaveLength(2);
    const [a, b] = entries as [Jf2Entry, Jf2Entry];
    expect(a._id).toBe("urn:a");
    expect(a.url).toBe("https://bob.example/a");
    expect(a.content?.html).toContain("body");
    expect(a.category).toEqual(["tech"]);
    expect(a.author?.name).toBe("Bob");
    // Falls back to updated + summary-as-content + first link.
    expect(b.url).toBe("https://bob.example/b");
    expect(b.published).toBe("2026-02-02T00:00:00Z");
    expect(b.content?.html).toBe("just a summary");
  });
});

describe("parseFeed — RSS", () => {
  const body = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel>
      <title>Feed</title>
      <item>
        <title>Item 1</title>
        <link>https://site.example/1</link>
        <guid>https://site.example/1</guid>
        <pubDate>Wed, 01 Apr 2026 12:00:00 GMT</pubDate>
        <description>desc</description>
        <content:encoded><![CDATA[<p>full</p>]]></content:encoded>
        <category>news</category>
        <dc:creator>Carol</dc:creator>
      </item>
    </channel>
  </rss>`;

  it("maps items, preferring content:encoded and dc:creator", () => {
    const entries = parseFeed(
      body,
      "application/rss+xml",
      "https://site.example/",
    );
    expect(entries).toHaveLength(1);
    const [item] = entries as [Jf2Entry];
    expect(item._id).toBe("https://site.example/1");
    expect(item.url).toBe("https://site.example/1");
    expect(item.content?.html).toContain("full");
    expect(item.summary).toBe("desc");
    expect(item.author?.name).toBe("Carol");
    expect(item.category).toEqual(["news"]);
  });

  it("returns [] for an unrecognised root element", () => {
    expect(
      parseFeed(
        "<html><body>no feed</body></html>",
        "text/xml",
        "https://x.example/",
      ),
    ).toEqual([]);
  });
});
