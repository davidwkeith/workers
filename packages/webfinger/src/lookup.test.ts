import { describe, expect, it } from "vitest";

import {
  parseHandle,
  resolveHandle,
  selectActorLink,
  webfingerQueryUrl,
} from "./lookup.js";

const JRD = {
  subject: "acct:birding@lemmy.example",
  links: [
    {
      rel: "http://webfinger.net/rel/profile-page",
      href: "https://lemmy.example/c/birding",
    },
    {
      rel: "self",
      type: "application/activity+json",
      href: "https://lemmy.example/c/birding",
    },
  ],
};

describe("parseHandle", () => {
  it("parses bare, @-prefixed, !-prefixed, and acct: handles", () => {
    for (const raw of [
      "birding@lemmy.example",
      "@birding@lemmy.example",
      "!birding@lemmy.example",
      "acct:birding@lemmy.example",
    ]) {
      expect(parseHandle(raw)).toEqual({
        user: "birding",
        host: "lemmy.example",
      });
    }
  });

  it("lowercases the host but keeps the user's case", () => {
    expect(parseHandle("Birding@LEMMY.Example")).toEqual({
      user: "Birding",
      host: "lemmy.example",
    });
  });

  it("rejects malformed handles", () => {
    for (const raw of [
      "",
      "birding",
      "@lemmy.example",
      "birding@",
      "a@b@c",
      "bir ding@lemmy.example",
      "bird/ing@lemmy.example",
      "birding@lemmy.example:8080",
      "birding@lemmy.example/path",
      "birding@bad host",
    ]) {
      expect(parseHandle(raw)).toBeNull();
    }
  });
});

describe("webfingerQueryUrl", () => {
  it("builds the RFC 7033 query with an encoded acct resource", () => {
    expect(webfingerQueryUrl({ user: "birding", host: "lemmy.example" })).toBe(
      "https://lemmy.example/.well-known/webfinger?resource=acct%3Abirding%40lemmy.example",
    );
  });
});

describe("selectActorLink", () => {
  it("selects the self link with an AS2 type", () => {
    expect(selectActorLink(JRD)).toBe("https://lemmy.example/c/birding");
  });

  it("accepts the ld+json AS2 profile variant", () => {
    expect(
      selectActorLink({
        links: [
          {
            rel: "self",
            type: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
            href: "https://social.example/users/alice",
          },
        ],
      }),
    ).toBe("https://social.example/users/alice");
  });

  it("ignores self links without an AS2 type and malformed JRDs", () => {
    expect(
      selectActorLink({
        links: [{ rel: "self", type: "text/html", href: "https://x.example" }],
      }),
    ).toBeNull();
    expect(selectActorLink(null)).toBeNull();
    expect(selectActorLink([])).toBeNull();
    expect(selectActorLink({ links: "nope" })).toBeNull();
    expect(selectActorLink({ links: [{ rel: "self" }] })).toBeNull();
  });
});

describe("resolveHandle", () => {
  const fetchJrd =
    (status: number, body: unknown): typeof globalThis.fetch =>
    async (input) => {
      expect(String(input)).toBe(
        "https://lemmy.example/.well-known/webfinger?resource=acct%3Abirding%40lemmy.example",
      );
      return new Response(JSON.stringify(body), { status });
    };

  it("resolves a handle end to end", async () => {
    const actor = await resolveHandle("!birding@lemmy.example", {
      fetch: fetchJrd(200, JRD),
    });
    expect(actor).toBe("https://lemmy.example/c/birding");
  });

  it("returns null on a bad handle without fetching", async () => {
    const actor = await resolveHandle("not-a-handle", {
      fetch: () => {
        throw new Error("must not fetch");
      },
    });
    expect(actor).toBeNull();
  });

  it("returns null on non-2xx, network error, and malformed JSON", async () => {
    expect(
      await resolveHandle("birding@lemmy.example", {
        fetch: fetchJrd(404, {}),
      }),
    ).toBeNull();
    expect(
      await resolveHandle("birding@lemmy.example", {
        fetch: async () => {
          throw new Error("boom");
        },
      }),
    ).toBeNull();
    expect(
      await resolveHandle("birding@lemmy.example", {
        fetch: async () => new Response("{not json", { status: 200 }),
      }),
    ).toBeNull();
  });
});
