import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  INTERNAL_HEADERS,
  deriveIris,
  type ActivityPubEnv,
  type ForwardedConfig,
} from "./config.js";

/**
 * Dereferencing an outbox activity, and the object its `Create` carried, by
 * IRI (AP §3.1). Driven directly against the Durable Object like
 * `object.test.ts`.
 */

const testEnv = env as unknown as ActivityPubEnv;

const BASE = "https://social.example";
const AS2 = "application/activity+json";

function freshUser() {
  const username = `item-${crypto.randomUUID().slice(0, 8)}`;
  const iris = deriveIris(BASE, username);
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));
  const config: ForwardedConfig = {
    iris,
    actorName: username,
    actorType: "Person",
    manuallyApprovesFollowers: false,
    manuallyApprovesJoins: false,
    verifyRelayedObjects: "tiered",
    moderators: [],
    pageSize: 50,
    deliveryMaxAttempts: 8,
    deliveryBaseDelayMs: 60_000,
    reportRetentionMs: 30 * 24 * 60 * 60 * 1000,
    keyId: iris.keyId,
    userAgent: "test-ua/1.0",
  };
  const cfg = JSON.stringify(config);
  const owner = (url: string, body: unknown) =>
    stub.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_HEADERS.config]: cfg,
          [INTERNAL_HEADERS.publish]: "1",
          [INTERNAL_HEADERS.skipDelivery]: "1",
        },
        body: JSON.stringify(body),
      }),
    );
  return {
    iris,
    publish: async (body: unknown) =>
      (await (await owner(`${iris.id}/publish`, body)).json()) as {
        id: string;
        object: { id: string };
      },
    outbox: (body: unknown) => owner(iris.outbox, body),
    get: (url: string, accept = AS2, method = "GET") =>
      stub.fetch(
        new Request(url, {
          method,
          headers: { accept, [INTERNAL_HEADERS.config]: cfg },
          redirect: "manual",
        }),
      ),
  };
}

describe("outbox items", () => {
  it("serves a published activity and its object at their IRIs", async () => {
    const user = freshUser();
    const created = await user.publish({
      kind: "note",
      content: "<p>Hello</p>",
      url: "https://blog.example/posts/hello",
    });

    const activity = await user.get(created.id);
    expect(activity.status).toBe(200);
    expect(activity.headers.get("content-type")).toContain("activity+json");
    expect(await activity.json()).toMatchObject({
      id: created.id,
      type: "Create",
      object: {
        id: created.object.id,
        url: "https://blog.example/posts/hello",
      },
    });

    const object = await user.get(created.object.id);
    expect(object.status).toBe(200);
    expect(await object.json()).toMatchObject({
      "@context": expect.anything(),
      id: created.object.id,
      type: "Note",
      content: "<p>Hello</p>",
      url: "https://blog.example/posts/hello",
    });
  });

  it("sends a browser asking for the object to its original url", async () => {
    const user = freshUser();
    const created = await user.publish({
      kind: "note",
      content: "x",
      url: "https://blog.example/posts/x",
    });
    const res = await user.get(created.object.id, "text/html");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://blog.example/posts/x");
    // No url to send it to: the AS2 document it is.
    const plain = await user.publish({ kind: "note", content: "y" });
    expect((await user.get(plain.object.id, "text/html")).status).toBe(200);
  });

  it("merges the owner's Updates into the object, and serves a Tombstone once deleted", async () => {
    const user = freshUser();
    const created = await user.publish({
      kind: "note",
      content: "v1",
      url: "https://blog.example/posts/v",
    });
    // A partial Update (AP §6.3) keeps the fields it doesn't name.
    await user.outbox({
      type: "Update",
      object: { id: created.object.id, type: "Note", content: "v2" },
    });
    // A blind-only Update is a private edit: never applied to the public copy.
    await user.outbox({
      type: "Update",
      bto: ["https://friend.example/users/bob"],
      object: { id: created.object.id, type: "Note", content: "private" },
    });
    for (const iri of [created.object.id, created.id]) {
      const body = (await (await user.get(iri)).json()) as {
        content?: string;
        url?: string;
        object?: { content: string; url: string };
      };
      expect(body.object ?? body).toMatchObject({
        content: "v2",
        url: "https://blog.example/posts/v",
      });
    }
    const redirect = await user.get(created.object.id, "text/html");
    expect(redirect.headers.get("location")).toBe(
      "https://blog.example/posts/v",
    );

    await user.outbox({ type: "Delete", object: created.object.id });
    for (const iri of [created.id, created.object.id]) {
      const gone = await user.get(iri);
      expect(gone.status).toBe(410);
      const body = (await gone.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: iri, type: "Tombstone" });
      expect(JSON.stringify(body)).not.toContain("v2");
    }
  });

  it("varies every answer on Accept", async () => {
    const user = freshUser();
    const created = await user.publish({
      kind: "note",
      content: "x",
      url: "https://blog.example/posts/x",
    });
    for (const [iri, accept] of [
      [created.id, AS2],
      [created.object.id, AS2],
      [created.object.id, "text/html"],
      [`${user.iris.outbox}/nope/object`, AS2],
    ] as const) {
      expect((await user.get(iri, accept)).headers.get("vary")).toBe("accept");
    }
  });

  it("never serves a restricted post, and strips blind addressing", async () => {
    const user = freshUser();
    const restricted = await user.publish({
      kind: "note",
      content: "secret",
      bto: ["https://friend.example/users/bob"],
    });
    for (const iri of [restricted.id, restricted.object.id]) {
      expect((await user.get(iri)).status).toBe(404);
    }

    const open = await user.publish({
      kind: "note",
      content: "open",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      bto: ["https://friend.example/users/bob"],
    });
    const body = JSON.stringify(await (await user.get(open.id)).json());
    expect(body).not.toContain("bob");
  });

  it("answers 404 for an unknown IRI and 405 for a write", async () => {
    const user = freshUser();
    expect((await user.get(`${user.iris.outbox}/nope`)).status).toBe(404);
    expect((await user.get(`${user.iris.outbox}/nope/object`)).status).toBe(
      404,
    );
    const created = await user.publish({ kind: "note", content: "z" });
    expect((await user.get(created.id, AS2, "PUT")).status).toBe(405);
  });
});
