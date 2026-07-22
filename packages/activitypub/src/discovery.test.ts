import { describe, expect, it } from "vitest";

import { resolveHandleGuarded } from "./discovery.js";

describe("resolveHandleGuarded", () => {
  it("resolves a public community handle through the guarded transport", async () => {
    let requested = "";
    const actor = await resolveHandleGuarded(
      "!birding@lemmy.example",
      async (input) => {
        requested = String(input);
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
    );

    expect(requested).toBe(
      "https://lemmy.example/.well-known/webfinger?resource=acct%3Abirding%40lemmy.example",
    );
    expect(actor).toBe("https://lemmy.example/c/birding");
  });
});
