import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config.js";

const config = {
  baseUrl: "https://example.com",
  me: "https://alice.example.com/",
};

describe("Micropub audience configuration", () => {
  it("rejects an audience without a uid or display name", () => {
    expect(() =>
      resolveConfig({
        ...config,
        audiences: [{ uid: "", name: "Family" }],
      }),
    ).toThrow("every audience requires non-empty `uid` and `name`");
    expect(() =>
      resolveConfig({
        ...config,
        audiences: [{ uid: "family", name: "" }],
      }),
    ).toThrow("every audience requires non-empty `uid` and `name`");
  });

  it("rejects duplicate audience ids and precomputes the accepted set", () => {
    expect(() =>
      resolveConfig({
        ...config,
        audiences: [
          { uid: "family", name: "Family" },
          { uid: "family", name: "Family again" },
        ],
      }),
    ).toThrow("audience `uid` values must be unique");

    const resolved = resolveConfig({
      ...config,
      audiences: [{ uid: "family", name: "Family" }],
    });
    expect(resolved.audienceIds).toEqual(new Set(["family"]));
  });
});

describe("Micropub fediverse configuration", () => {
  it("fails at startup when the fediverse actor can't be named", () => {
    expect(() =>
      resolveConfig({
        ...config,
        fediverse: { publishUrl: "https://s.example/post", publishToken: "t" },
      }),
    ).toThrow(/fediverse\.actorUrl/);
    expect(
      resolveConfig({
        ...config,
        fediverse: {
          publishUrl: "https://s.example/users/a/publish",
          publishToken: "t",
        },
      }).fediverse?.publishUrl,
    ).toBe("https://s.example/users/a/publish");
  });
});
