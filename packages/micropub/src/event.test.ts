import { describe, it, expect } from "vitest";
import { H_EVENT, isEvent, renderHEvent } from "./event.js";
import type { Mf2Object } from "./mf2.js";

/**
 * Extract a single mf2 property (text content or a chosen attribute) from
 * rendered markup using the runtime's `HTMLRewriter`, to confirm the output is
 * parseable back into the property it was rendered from. This is a focused
 * round-trip check, not a general mf2 parser.
 */
async function readProperty(
  html: string,
  cls: string,
  attr?: string,
): Promise<string[]> {
  const values: string[] = [];
  let text = "";
  let open = false;
  const rewriter = new HTMLRewriter().on(`[class~="${cls}"]`, {
    element(el) {
      if (attr !== undefined) {
        const value = el.getAttribute(attr);
        if (value !== null) values.push(value);
        return;
      }
      open = true;
      text = "";
      el.onEndTag(() => {
        values.push(text);
        open = false;
      });
    },
    text(chunk) {
      if (open) text += chunk.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  return values;
}

describe("isEvent", () => {
  it("recognizes the h-event type", () => {
    expect(isEvent({ type: [H_EVENT], properties: {} })).toBe(true);
    expect(isEvent({ type: ["h-entry"], properties: {} })).toBe(false);
  });
});

describe("renderHEvent", () => {
  const event: Mf2Object = {
    type: [H_EVENT],
    properties: {
      name: ["Indie Web Meetup"],
      start: ["2026-07-01T18:00:00-07:00"],
      end: ["2026-07-01T20:00:00-07:00"],
      location: ["Portland, OR"],
      category: ["indieweb", "meetup"],
    },
  };

  it("wraps the markup in an h-event root", () => {
    expect(renderHEvent(event)).toMatch(/^<div class="h-event">.*<\/div>$/s);
  });

  it("round-trips name/start/end/location through an HTML parser", async () => {
    const html = renderHEvent(event);
    expect(await readProperty(html, "p-name")).toEqual(["Indie Web Meetup"]);
    expect(await readProperty(html, "p-location")).toEqual(["Portland, OR"]);
    // dt-* values live on the `datetime` attribute of a <time> element.
    expect(await readProperty(html, "dt-start", "datetime")).toEqual([
      "2026-07-01T18:00:00-07:00",
    ]);
    expect(await readProperty(html, "dt-end", "datetime")).toEqual([
      "2026-07-01T20:00:00-07:00",
    ]);
  });

  it("emits each value of a multi-valued property", async () => {
    const html = renderHEvent(event);
    expect(await readProperty(html, "p-category")).toEqual([
      "indieweb",
      "meetup",
    ]);
  });

  it("renders url as a u-* anchor href", async () => {
    const html = renderHEvent({
      type: [H_EVENT],
      properties: { url: ["https://example.com/party"] },
    });
    expect(await readProperty(html, "u-url", "href")).toEqual([
      "https://example.com/party",
    ]);
  });

  it("emits e-content HTML verbatim and escapes plain-text values", () => {
    const withHtml = renderHEvent({
      type: [H_EVENT],
      properties: { content: [{ html: "<p>Bring <b>snacks</b></p>" }] },
    });
    expect(withHtml).toContain(
      '<div class="e-content"><p>Bring <b>snacks</b></p></div>',
    );
    const withText = renderHEvent({
      type: [H_EVENT],
      properties: { name: ["A & B <tag>"] },
    });
    expect(withText).toContain(
      '<span class="p-name">A &amp; B &lt;tag&gt;</span>',
    );
  });

  it("reads a nested location microformat's name", async () => {
    const html = renderHEvent({
      type: [H_EVENT],
      properties: {
        location: [{ type: ["h-card"], properties: { name: ["The Hall"] } }],
      },
    });
    expect(await readProperty(html, "p-location")).toEqual(["The Hall"]);
  });
});
