import { describe, expect, it } from "vitest";

import { guardedFetch, resolveHandleGuarded } from "./discovery.js";

const TEST_UA = "test-ua/1.0 (+https://example.com/)";

describe("resolveHandleGuarded", () => {
  it("resolves a public community handle through the guarded transport", async () => {
    let requested = "";
    let userAgent: string | null = null;
    const actor = await resolveHandleGuarded(
      "!birding@lemmy.example",
      async (input, init) => {
        requested = String(input);
        userAgent = new Headers(init?.headers).get("user-agent");
        return new Response(
          JSON.stringify({
            links: [
              {
                rel: "self",
                type: "application/activity+json",
                href: "https://lemmy.example/c/birding",
              },
            ],
          }),
          { status: 200 },
        );
      },
      TEST_UA,
    );

    expect(requested).toBe(
      "https://lemmy.example/.well-known/webfinger?resource=acct%3Abirding%40lemmy.example",
    );
    expect(actor).toBe("https://lemmy.example/c/birding");
    // `resolveHandle` has no header-customization seam of its own, so
    // `guardedFetch` is the only place a descriptive UA can be injected — some
    // peers' anti-scraper challenge layers key allow/deny rules off it.
    expect(userAgent).toBe(TEST_UA);
  });
});

describe("guardedFetch", () => {
  it("adds the given User-Agent when the caller sets none", async () => {
    let seen: string | null = null;
    const wrapped = guardedFetch(async (_input, init) => {
      seen = new Headers(init?.headers).get("user-agent");
      return new Response(null, { status: 200 });
    }, TEST_UA);
    await wrapped("https://remote.example/users/bob");
    expect(seen).toBe(TEST_UA);
  });

  it("does not override a caller-set User-Agent", async () => {
    let seen: string | null = null;
    const wrapped = guardedFetch(async (_input, init) => {
      seen = new Headers(init?.headers).get("user-agent");
      return new Response(null, { status: 200 });
    }, TEST_UA);
    await wrapped("https://remote.example/users/bob", {
      headers: { "user-agent": "custom-caller-ua" },
    });
    expect(seen).toBe("custom-caller-ua");
  });

  it("still rejects an unsafe target", () => {
    const wrapped = guardedFetch(async () => new Response(null), TEST_UA);
    // The SSRF guard runs synchronously before the wrapped fetch is invoked.
    expect(() => wrapped("https://127.0.0.1/x")).toThrow();
  });
});
