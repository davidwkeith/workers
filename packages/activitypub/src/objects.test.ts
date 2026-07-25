import { describe, expect, it } from "vitest";

import { PUBLIC_AUDIENCE } from "./as2.js";
import { deriveIris } from "./config.js";
import {
  buildAnnounceActivity,
  buildPostActivity,
  buildPostObject,
  classifyActivity,
  isValidPublished,
  parsePostInput,
  postAddressing,
} from "./objects.js";

const IRIS = deriveIris("https://social.example", "alice");
const IDS = {
  activityId: `${IRIS.outbox}/act-1`,
  objectId: `${IRIS.outbox}/act-1/object`,
  published: "2026-07-19T00:00:00.000Z",
};
const GROUP = "https://lemmy.example/c/birding";

function parsed(value: unknown) {
  const result = parsePostInput(value);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.input;
}

function rejected(value: unknown): string {
  const result = parsePostInput(value);
  if (result.ok) throw new Error("expected a validation error");
  return result.error;
}

describe("parsePostInput", () => {
  it("accepts a minimal note", () => {
    const input = parsed({ kind: "note", content: "<p>hi</p>" });
    expect(input.kind).toBe("note");
    expect(input.content).toBe("<p>hi</p>");
  });

  it("rejects non-object bodies and unknown kinds", () => {
    expect(rejected(null)).toMatch(/JSON object/);
    expect(rejected([])).toMatch(/JSON object/);
    expect(rejected({ kind: "video", content: "x" })).toMatch(/`kind`/);
  });

  it("rejects an empty or missing content", () => {
    expect(rejected({ kind: "note" })).toMatch(/`content`/);
    expect(rejected({ kind: "note", content: "" })).toMatch(/`content`/);
  });

  it("requires a title for a page (Lemmy top-level post)", () => {
    expect(rejected({ kind: "page", content: "body" })).toMatch(/`name`/);
    const input = parsed({ kind: "page", content: "body", name: "Title" });
    expect(input.name).toBe("Title");
  });

  it("validates attachments", () => {
    expect(
      rejected({ kind: "note", content: "x", attachments: [{ type: "Gif" }] }),
    ).toMatch(/attachments\[0\]\.type/);
    expect(
      rejected({
        kind: "note",
        content: "x",
        attachments: [{ type: "Image", url: "ftp://media.example/a.jpg" }],
      }),
    ).toMatch(/attachments\[0\]\.url/);
    expect(
      rejected({
        kind: "note",
        content: "x",
        attachments: [
          { type: "Image", url: "https://media.example/a.jpg", width: -1 },
        ],
      }),
    ).toMatch(/width/);
    const input = parsed({
      kind: "note",
      content: "x",
      attachments: [
        {
          type: "Image",
          url: "https://media.example/a.jpg",
          mediaType: "image/jpeg",
          name: "a bird",
          blurhash: "LEHV6nWB2yk8",
          width: 1024,
          height: 768,
        },
      ],
    });
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments?.[0]?.name).toBe("a bird");
  });

  it("validates inReplyTo / audience as http(s) IRIs", () => {
    expect(
      rejected({ kind: "note", content: "x", audience: "!c@host" }),
    ).toMatch(/`audience`/);
    expect(
      rejected({ kind: "note", content: "x", inReplyTo: "not-a-url" }),
    ).toMatch(/`inReplyTo`/);
    const input = parsed({ kind: "note", content: "x", audience: GROUP });
    expect(input.audience).toBe(GROUP);
  });

  it("normalizes hashtags and drops empties", () => {
    const input = parsed({
      kind: "note",
      content: "x",
      tags: ["#birds", "nature", "#"],
    });
    expect(input.tags).toEqual(["birds", "nature"]);
  });

  it("validates to/cc overrides as addressable IRIs", () => {
    expect(rejected({ kind: "note", content: "x", to: ["not a url"] })).toMatch(
      /`to`/,
    );
    const input = parsed({
      kind: "note",
      content: "x",
      to: [PUBLIC_AUDIENCE],
      cc: ["https://remote.example/users/bob"],
    });
    expect(input.to).toEqual([PUBLIC_AUDIENCE]);
    expect(input.cc).toEqual(["https://remote.example/users/bob"]);
  });

  it("rejects a non-boolean sensitive flag", () => {
    expect(rejected({ kind: "note", content: "x", sensitive: "yes" })).toMatch(
      /`sensitive`/,
    );
  });

  it("validates published as an ISO-8601 timestamp", () => {
    expect(
      rejected({ kind: "note", content: "x", published: "not-a-date" }),
    ).toMatch(/`published`/);
    const input = parsed({
      kind: "note",
      content: "x",
      published: "2019-03-01T12:00:00.000Z",
    });
    expect(input.published).toBe("2019-03-01T12:00:00.000Z");
  });
});

describe("postAddressing", () => {
  it("defaults to Public + followers", () => {
    const { to, cc } = postAddressing(
      parsed({ kind: "note", content: "x" }),
      IRIS,
    );
    expect(to).toEqual([PUBLIC_AUDIENCE]);
    expect(cc).toEqual([IRIS.followers]);
  });

  it("puts the community first in `to` when audience is set", () => {
    const { to } = postAddressing(
      parsed({ kind: "page", content: "x", name: "T", audience: GROUP }),
      IRIS,
    );
    expect(to).toEqual([GROUP, PUBLIC_AUDIENCE]);
  });

  it("lets explicit to/cc overrides win", () => {
    const { to, cc } = postAddressing(
      parsed({
        kind: "note",
        content: "x",
        audience: GROUP,
        to: [PUBLIC_AUDIENCE],
        cc: [],
      }),
      IRIS,
    );
    expect(to).toEqual([PUBLIC_AUDIENCE]);
    // An empty cc array is dropped at parse time, so the default applies.
    expect(cc).toEqual([IRIS.followers]);
  });
});

describe("buildPostObject / buildPostActivity", () => {
  it("builds a media note the way Pixelfed renders it", () => {
    const object = buildPostObject(
      parsed({
        kind: "note",
        content: "<p>a bird!</p>",
        sensitive: true,
        summary: "cw: bird",
        attachments: [
          {
            type: "Image",
            url: "https://media.example/bird.jpg",
            mediaType: "image/jpeg",
            name: "a heron",
            blurhash: "LEHV6nWB2yk8",
          },
        ],
        tags: ["birds"],
      }),
      IRIS,
      IDS,
    );
    expect(object.type).toBe("Note");
    expect(object.attributedTo).toBe(IRIS.id);
    expect(object.sensitive).toBe(true);
    expect(object.summary).toBe("cw: bird");
    expect(object.attachment).toEqual([
      {
        type: "Image",
        url: "https://media.example/bird.jpg",
        mediaType: "image/jpeg",
        name: "a heron",
        blurhash: "LEHV6nWB2yk8",
      },
    ]);
    expect(object.tag).toEqual([{ type: "Hashtag", name: "#birds" }]);
  });

  it("builds a titled Page addressed to the community", () => {
    const activity = buildPostActivity(
      parsed({
        kind: "page",
        content: "<p>look at this heron</p>",
        name: "Heron spotting",
        audience: GROUP,
      }),
      IRIS,
      IDS,
    );
    expect(activity.type).toBe("Create");
    expect(activity.id).toBe(IDS.activityId);
    expect(activity.actor).toBe(IRIS.id);
    expect(activity.audience).toBe(GROUP);
    expect(activity.to).toEqual([GROUP, PUBLIC_AUDIENCE]);
    const object = activity.object as Record<string, unknown>;
    expect(object.type).toBe("Page");
    expect(object.name).toBe("Heron spotting");
    expect(object.audience).toBe(GROUP);
    expect(object.id).toBe(IDS.objectId);
  });

  it("builds an Article and omits unset optionals", () => {
    const object = buildPostObject(
      parsed({ kind: "article", content: "long form", name: "Essay" }),
      IRIS,
      IDS,
    );
    expect(object.type).toBe("Article");
    expect(object).not.toHaveProperty("sensitive");
    expect(object).not.toHaveProperty("attachment");
    expect(object).not.toHaveProperty("audience");
    expect(object).not.toHaveProperty("inReplyTo");
  });
});

describe("buildAnnounceActivity (#376)", () => {
  it("wraps a member's activity in a Group-authored Announce addressed to the membership", () => {
    const memberCreate = {
      id: "https://member.example/activities/1",
      type: "Create",
      actor: "https://member.example/users/alice",
      object: { id: "https://member.example/activities/1/object" },
    };
    const announce = buildAnnounceActivity(
      IRIS,
      `${IRIS.outbox}/announce-1`,
      IDS.published,
      memberCreate,
    );
    expect(announce.type).toBe("Announce");
    expect(announce.id).toBe(`${IRIS.outbox}/announce-1`);
    expect(announce.actor).toBe(IRIS.id);
    expect(announce.published).toBe(IDS.published);
    expect(announce.to).toEqual([PUBLIC_AUDIENCE]);
    expect(announce.cc).toEqual([IRIS.followers]);
    expect(announce.object).toEqual(memberCreate);
  });
});

describe("classifyActivity", () => {
  it("classifies a Create(Note)", () => {
    expect(
      classifyActivity({
        type: "Create",
        object: { type: "Note", content: "hi" },
      }),
    ).toEqual({ objectType: "Note" });
  });

  it("resolves an object-shaped audience to its id", () => {
    expect(
      classifyActivity({
        type: "Create",
        audience: { type: "Group", id: GROUP },
        object: { type: "Page" },
      }),
    ).toEqual({ objectType: "Page", audience: GROUP });
    expect(
      classifyActivity({
        type: "Create",
        audience: [{ type: "Group", id: GROUP }],
        object: { type: "Page" },
      }),
    ).toEqual({ objectType: "Page", audience: GROUP });
  });

  it("reads the audience from the activity or the embedded object", () => {
    expect(
      classifyActivity({
        type: "Create",
        audience: GROUP,
        object: { type: "Page" },
      }),
    ).toEqual({ objectType: "Page", audience: GROUP });
    expect(
      classifyActivity({
        type: "Create",
        object: { type: "Page", audience: [GROUP] },
      }),
    ).toEqual({ objectType: "Page", audience: GROUP });
  });

  it("never treats the Public collection as a community audience", () => {
    expect(
      classifyActivity({
        type: "Create",
        audience: PUBLIC_AUDIENCE,
        object: { type: "Note" },
      }),
    ).toEqual({ objectType: "Note" });
  });

  it("yields an empty classification for opaque shapes", () => {
    expect(
      classifyActivity({ type: "Like", object: "https://x.example/1" }),
    ).toEqual({});
    expect(classifyActivity({ type: "Weird" })).toEqual({});
  });
});

describe("isValidPublished", () => {
  it("accepts parseable ISO-8601 strings and rejects everything else", () => {
    expect(isValidPublished("2019-03-01T12:00:00.000Z")).toBe(true);
    expect(isValidPublished("not-a-date")).toBe(false);
    expect(isValidPublished("")).toBe(false);
    expect(isValidPublished(undefined)).toBe(false);
    expect(isValidPublished(12345)).toBe(false);
  });
});
