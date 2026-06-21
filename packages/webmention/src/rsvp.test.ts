import { describe, it, expect } from "vitest";
import { extractRsvp, isRsvpValue, RSVP_VALUES } from "./rsvp.js";

const target = "https://example.com/party";
const source = "https://blog.example/rsvp";

describe("isRsvpValue", () => {
  it("recognizes exactly the four rsvp tokens", () => {
    for (const value of RSVP_VALUES) {
      expect(isRsvpValue(value)).toBe(true);
    }
    expect(isRsvpValue("attending")).toBe(false);
    expect(isRsvpValue("")).toBe(false);
  });
});

describe("extractRsvp", () => {
  it("reads the rsvp value from a `<data value>` reply to the target", async () => {
    const html =
      '<div class="h-entry">' +
      `<a class="u-in-reply-to" href="${target}">the party</a>` +
      '<data class="p-rsvp" value="yes">going</data>' +
      "</div>";
    expect(await extractRsvp(html, source, target)).toBe("yes");
  });

  it("falls back to element text when there is no value attribute", async () => {
    const html =
      `<a class="u-in-reply-to" href="${target}">x</a>` +
      '<p class="p-rsvp">Maybe</p>';
    expect(await extractRsvp(html, source, target)).toBe("maybe");
  });

  it("resolves a relative in-reply-to against the base before matching", async () => {
    const html =
      '<a class="u-in-reply-to" href="/party">x</a>' +
      '<data class="p-rsvp" value="interested"></data>';
    expect(await extractRsvp(html, "https://example.com/feed", target)).toBe(
      "interested",
    );
  });

  it("is null when the rsvp replies to a different post", async () => {
    const html =
      '<a class="u-in-reply-to" href="https://example.com/other">x</a>' +
      '<data class="p-rsvp" value="yes"></data>';
    expect(await extractRsvp(html, source, target)).toBeNull();
  });

  it("is null when there is an in-reply-to but no rsvp", async () => {
    const html = `<a class="u-in-reply-to" href="${target}">x</a>`;
    expect(await extractRsvp(html, source, target)).toBeNull();
  });

  it("is null for an unrecognized rsvp token", async () => {
    const html =
      `<a class="u-in-reply-to" href="${target}">x</a>` +
      '<data class="p-rsvp" value="attending"></data>';
    expect(await extractRsvp(html, source, target)).toBeNull();
  });

  it("prefers the value attribute over the element text", async () => {
    const html =
      `<a class="u-in-reply-to" href="${target}">x</a>` +
      '<data class="p-rsvp" value="no">I will be there</data>';
    expect(await extractRsvp(html, source, target)).toBe("no");
  });
});
