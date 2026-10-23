import { describe, expect, it } from "vitest";

import {
  FEDIVERSE_TARGET_UID,
  deliverFediversePost,
  entryToFediversePost,
  retractFediverseCopies,
  syndicateEntry,
} from "./fediverse.js";
import type { Mf2Object } from "./mf2.js";

const GROUP = "https://lemmy.example/c/birding";

function entry(properties: Record<string, unknown[]>): Mf2Object {
  return { type: ["h-entry"], properties };
}

function post(mf2: Mf2Object, audience?: string) {
  const result = entryToFediversePost(
    mf2,
    audience !== undefined ? { audience } : {},
  );
  if (typeof result === "string") throw new Error(`expected post: ${result}`);
  return result;
}

describe("entryToFediversePost", () => {
  it("links back to the entry's permalink", () => {
    const mapped = entryToFediversePost(entry({ content: ["hi"] }), {
      url: "https://blog.example/p",
    });
    expect(mapped).toMatchObject({ url: "https://blog.example/p" });
    expect(post(entry({ content: ["hi"] })).url).toBeUndefined();
  });

  it("maps plain content to a note", () => {
    const mapped = post(entry({ content: ["hello"] }));
    expect(mapped.kind).toBe("note");
    expect(mapped.content).toBe("hello");
  });

  it("prefers the html variant of structured content", () => {
    const mapped = post(
      entry({ content: [{ html: "<p>rich</p>", value: "rich" }] }),
    );
    expect(mapped.content).toBe("<p>rich</p>");
  });

  it("maps name + content to an article", () => {
    const mapped = post(entry({ name: ["Essay"], content: ["long form"] }));
    expect(mapped.kind).toBe("article");
    expect(mapped.name).toBe("Essay");
  });

  it("maps photos to Image attachments with alt text (Pixelfed shape)", () => {
    const mapped = post(
      entry({
        content: ["a bird"],
        photo: [
          "https://media.example/1.jpg",
          { value: "https://media.example/2.jpg", alt: "a heron" },
        ],
        category: ["birds", "nature"],
        summary: ["cw: bird"],
      }),
    );
    expect(mapped.kind).toBe("note");
    expect(mapped.attachments).toEqual([
      { type: "Image", url: "https://media.example/1.jpg" },
      { type: "Image", url: "https://media.example/2.jpg", name: "a heron" },
    ]);
    expect(mapped.tags).toEqual(["birds", "nature"]);
    expect(mapped.summary).toBe("cw: bird");
  });

  it("maps a community target to a titled page", () => {
    const mapped = post(
      entry({ name: ["Heron spotting"], content: ["look"] }),
      GROUP,
    );
    expect(mapped.kind).toBe("page");
    expect(mapped.audience).toBe(GROUP);
  });

  it("rejects unmappable entries with a reason", () => {
    expect(entryToFediversePost({ type: ["h-event"], properties: {} })).toMatch(
      /h-entry/,
    );
    expect(entryToFediversePost(entry({}))).toMatch(/content/);
    expect(
      entryToFediversePost(entry({ content: ["x"] }), { audience: GROUP }),
    ).toMatch(/name/);
  });
});

describe("syndicateEntry", () => {
  const config = (impl: typeof fetch) => ({
    publishUrl: "https://social.example/users/alice/publish",
    publishToken: "s3cret",
    fetch: impl,
  });

  it("publishes to the followers target and advertised communities only", async () => {
    const bodies: { audience?: string }[] = [];
    const results = await syndicateEntry(
      config(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { audience?: string });
        return new Response("{}", {
          status: 201,
          headers: { location: "https://social.example/act/1" },
        });
      }),
      entry({ name: ["T"], content: ["x"] }),
      [FEDIVERSE_TARGET_UID, GROUP, "https://twitter.example/you"],
      [{ uid: GROUP }],
    );
    // The unknown target is ignored, not failed.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]?.location).toBe("https://social.example/act/1");
    expect(bodies[0]?.audience).toBeUndefined();
    expect(bodies[1]?.audience).toBe(GROUP);
  });

  it("reports mapping and delivery failures without throwing", async () => {
    const results = await syndicateEntry(
      config(async () => new Response("bad", { status: 400 })),
      entry({ content: ["no title"] }),
      [GROUP],
      [{ uid: GROUP }],
    );
    // Community post without a name: mapping fails client-side.
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toMatch(/name/);

    const delivered = await syndicateEntry(
      config(async () => new Response("boom", { status: 500 })),
      entry({ content: ["x"] }),
      [FEDIVERSE_TARGET_UID],
      [],
    );
    expect(delivered[0]?.ok).toBe(false);
    expect(delivered[0]?.error).toMatch(/500/);
  });
});

describe("deliverFediversePost", () => {
  it("sends the bearer token and JSON body", async () => {
    let auth: string | null = null;
    const result = await deliverFediversePost(
      {
        publishUrl: "https://social.example/users/alice/publish",
        publishToken: "s3cret",
        fetch: async (_input, init) => {
          auth = new Headers(init?.headers).get("authorization");
          return new Response("{}", { status: 201 });
        },
      },
      FEDIVERSE_TARGET_UID,
      { kind: "note", content: "x" },
    );
    expect(result.ok).toBe(true);
    expect(auth).toBe("Bearer s3cret");
  });

  it("returns the created object's IRI from the response body", async () => {
    const deliver = (body: string) =>
      deliverFediversePost(
        {
          publishUrl: "https://social.example/users/alice/publish",
          publishToken: "s3cret",
          fetch: async () => new Response(body, { status: 201 }),
        },
        FEDIVERSE_TARGET_UID,
        { kind: "note", content: "x", url: "https://blog.example/p" },
      );
    const ok = await deliver(
      JSON.stringify({ object: { id: "https://social.example/o/1" } }),
    );
    expect(ok.object).toBe("https://social.example/o/1");
    // A body without one (or not JSON, or not an http(s) IRI) is still a success.
    for (const body of ["{}", "not json", '{"object":{"id":"javascript:x"}}']) {
      const result = await deliver(body);
      expect(result.ok).toBe(true);
      expect(result.object).toBeUndefined();
    }
  });

  it("stays non-fatal when reading a failure body itself fails", async () => {
    const result = await deliverFediversePost(
      {
        publishUrl: "https://social.example/users/alice/publish",
        publishToken: "s3cret",
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection cut"));
              },
            }),
            { status: 500 },
          ),
      },
      FEDIVERSE_TARGET_UID,
      { kind: "note", content: "x" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(result.error).toMatch(/failed to read/);
  });

  it("captures network failures as errors", async () => {
    const result = await deliverFediversePost(
      {
        publishUrl: "https://social.example/users/alice/publish",
        publishToken: "s3cret",
        fetch: async () => {
          throw new Error("offline");
        },
      },
      FEDIVERSE_TARGET_UID,
      { kind: "note", content: "x" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/offline/);
  });
});

describe("retractFediverseCopies", () => {
  const OUTBOX = "https://social.example/users/alice/outbox";

  it("deletes only the actor's own copies, through a configured outbox too", async () => {
    const seen: string[] = [];
    const results = await retractFediverseCopies(
      {
        publishUrl: "https://social.example/users/alice/publish",
        publishToken: "s3cret",
        outboxUrl: OUTBOX,
        fetch: async (input, init) => {
          seen.push(
            `${String(input)} ${new Headers(init?.headers).get("authorization")}`,
          );
          return new Response(null, { status: 201 });
        },
      },
      [
        `${OUTBOX}/1/object`,
        "https://bsky.example/post/1",
        42,
        `${OUTBOX}-evil/x`,
      ],
    );
    expect(results).toEqual([{ object: `${OUTBOX}/1/object`, ok: true }]);
    expect(seen).toEqual([`${OUTBOX} Bearer s3cret`]);
  });

  it("reports failures without throwing", async () => {
    const config = (impl: typeof fetch) => ({
      publishUrl: "https://social.example/users/alice/publish",
      publishToken: "s3cret",
      fetch: impl,
    });
    const refused = await retractFediverseCopies(
      config(async () => new Response("no", { status: 403 })),
      [`${OUTBOX}/1/object`],
    );
    expect(refused).toEqual([
      { object: `${OUTBOX}/1/object`, ok: false, error: "outbox answered 403" },
    ]);
    const offline = await retractFediverseCopies(
      config(async () => {
        throw new Error("down");
      }),
      [`${OUTBOX}/1/object`],
    );
    expect(offline[0]?.ok).toBe(false);
  });
});
