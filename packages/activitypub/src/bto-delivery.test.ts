import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  INTERNAL_HEADERS,
  deriveIris,
  type ActivityPubEnv,
  type ForwardedConfig,
} from "./config.js";
import { PUBLIC_AUDIENCE } from "./as2.js";

/**
 * Blind-addressed (`bto`/`bcc`) restricted delivery from the outbox (#496):
 * an owner-published activity addressed only blindly is delivered to each
 * listed recipient's own inbox and never surfaces in the public outbox
 * collection; `bto`/`bcc` are stripped from every delivered payload and every
 * served representation (AP §6.1). Driven directly against the Durable Object
 * like `object.test.ts`.
 */

const testEnv = env as unknown as ActivityPubEnv;

const BASE = "https://social.example";
const FOLLOWER = "https://remote.example/users/alice";
const FRIEND = "https://friend.example/users/bob";

/** A fresh, isolated DO bound to a unique actor IRI. */
function freshUser() {
  const username = `bto-${crypto.randomUUID().slice(0, 8)}`;
  const iris = deriveIris(BASE, username);
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));
  return { username, iris, stub };
}

/** The forwarded-config header the front door sets, for direct DO calls. */
function cfgHeader(
  username: string,
  overrides: Partial<ForwardedConfig> = {},
): string {
  const iris = deriveIris(BASE, username);
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
    ...overrides,
  };
  return JSON.stringify(config);
}

function outboxRequest(
  username: string,
  body: string,
  { skipDelivery = false } = {},
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/activity+json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
    [INTERNAL_HEADERS.publish]: "1",
  };
  if (skipDelivery) headers[INTERNAL_HEADERS.skipDelivery] = "1";
  return new Request(iris.outbox, { method: "POST", headers, body });
}

function publishPostRequest(username: string, body: unknown): Request {
  const iris = deriveIris(BASE, username);
  return new Request(`${iris.id}/publish`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INTERNAL_HEADERS.config]: cfgHeader(username),
      [INTERNAL_HEADERS.publish]: "1",
    },
    body: JSON.stringify(body),
  });
}

function collectionRequest(username: string, url: string): Request {
  return new Request(url, {
    headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
  });
}

/** Swap the global `fetch` for the body of a callback, restoring it after. */
async function withFetch<T>(
  impl: (url: string | URL, init?: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function seedFollower(state: DurableObjectState, actor = FOLLOWER): void {
  state.storage.sql.exec(
    `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, 1)`,
    actor,
    `${actor}/inbox`,
  );
}

/** The queued blind targeted deliveries (`pending_accept` kind 'deliver_direct'). */
function blindDeliveries(state: DurableObjectState): {
  actor: string;
  activity: Record<string, unknown>;
}[] {
  return state.storage.sql
    .exec<{ actor: string; json: string }>(
      `SELECT actor, json FROM pending_accept WHERE kind = 'deliver_direct' ORDER BY seq`,
    )
    .toArray()
    .map((row) => ({
      actor: row.actor,
      activity: JSON.parse(row.json) as Record<string, unknown>,
    }));
}

function counts(state: DurableObjectState, table: string): number {
  return state.storage.sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    .one().n;
}

describe("bto-only restricted publish (raw AS2 outbox)", () => {
  it("delivers to each bto recipient and skips follower fan-out", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            bto: [FRIEND],
            object: { type: "Note", content: "for your eyes only" },
          }),
        ),
      );
      expect(res.status).toBe(201);

      // The follower never hears about a restricted post…
      expect(counts(state, "delivery")).toBe(0);
      // …but each blind recipient gets a targeted delivery, with the blind
      // addressing stripped from the payload it will receive (AP §6.1).
      const blind = blindDeliveries(state);
      expect(blind.map((d) => d.actor)).toEqual([FRIEND]);
      expect(blind[0]!.activity.bto).toBeUndefined();
      expect(blind[0]!.activity.bcc).toBeUndefined();

      // The stored row is flagged restricted, with its addressing intact.
      const row = state.storage.sql
        .exec<{ restricted: number | null; json: string }>(
          `SELECT restricted, json FROM outbox`,
        )
        .one();
      expect(row.restricted).toBe(1);
      expect((JSON.parse(row.json) as Record<string, unknown>).bto).toEqual([
        FRIEND,
      ]);
    });
  });

  it("never surfaces a restricted activity in the outbox collection or stats", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            bto: [FRIEND],
            object: { type: "Note", content: "private" },
          }),
        ),
      );
      await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            to: [PUBLIC_AUDIENCE],
            object: { type: "Note", content: "public" },
          }),
        ),
      );

      const head = (await (
        await instance.fetch(collectionRequest(username, iris.outbox))
      ).json()) as Record<string, unknown>;
      expect(head.totalItems).toBe(1);

      const page = (await (
        await instance.fetch(
          collectionRequest(username, `${iris.outbox}?page=1`),
        )
      ).json()) as { orderedItems: Record<string, unknown>[] };
      expect(page.orderedItems).toHaveLength(1);
      const served = page.orderedItems[0]!;
      expect((served.object as Record<string, unknown>).content).toBe("public");

      const stats = (await (
        await instance.fetch(collectionRequest(username, `${iris.id}/__stats`))
      ).json()) as Record<string, unknown>;
      expect(stats.localPosts).toBe(1);
    });
  });

  it("keeps a restricted backfill row (skipDelivery) hidden without queuing delivery", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            bto: [FRIEND],
            object: { type: "Note", content: "old private post" },
          }),
          { skipDelivery: true },
        ),
      );
      expect(res.status).toBe(201);
      expect(counts(state, "pending_accept")).toBe(0);
      expect(counts(state, "delivery")).toBe(0);
      const head = (await (
        await instance.fetch(collectionRequest(username, iris.outbox))
      ).json()) as Record<string, unknown>;
      expect(head.totalItems).toBe(0);
    });
  });

  it("does not default a bare bto object to public addressing when wrapping it", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Note",
            content: "a bare restricted note",
            bto: [FRIEND],
          }),
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.type).toBe("Create");
      expect(activity.to).toEqual([]);
      expect(activity.cc).toEqual([]);
      expect(activity.bto).toEqual([FRIEND]);

      expect(counts(state, "delivery")).toBe(0);
      expect(blindDeliveries(state).map((d) => d.actor)).toEqual([FRIEND]);
      const head = (await (
        await instance.fetch(collectionRequest(username, iris.outbox))
      ).json()) as Record<string, unknown>;
      expect(head.totalItems).toBe(0);
    });
  });

  it("skips a community audience delivery when the activity is restricted", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const group = "https://lemmy.example/c/birding";
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at, inbox, shared_inbox)
           VALUES (?, 'accepted', 1, ?, ?)`,
        group,
        `${group}/inbox`,
        "https://lemmy.example/inbox",
      );
      await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            bto: [FRIEND],
            audience: group,
            object: { type: "Note", content: "not for the whole community" },
          }),
        ),
      );
      // A restricted post must not reach a Group inbox — the group would
      // Announce it to the whole membership.
      expect(counts(state, "delivery")).toBe(0);
      expect(blindDeliveries(state).map((d) => d.actor)).toEqual([FRIEND]);
    });
  });
});

describe("public publish carrying bto", () => {
  it("fans out to followers with bto stripped and lists publicly without it", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            to: [PUBLIC_AUDIENCE],
            cc: [iris.followers],
            bto: [FRIEND],
            object: { type: "Note", content: "public with a nudge" },
          }),
        ),
      );
      expect(res.status).toBe(201);

      // Follower fan-out still happens, and its payload carries no bto.
      const deliveries = state.storage.sql
        .exec<{ inbox: string; json: string }>(
          `SELECT inbox, json FROM delivery`,
        )
        .toArray();
      expect(deliveries.map((d) => d.inbox)).toEqual([`${FOLLOWER}/inbox`]);
      expect(
        (JSON.parse(deliveries[0]!.json) as Record<string, unknown>).bto,
      ).toBeUndefined();

      // The blind recipient still gets a targeted delivery.
      expect(blindDeliveries(state).map((d) => d.actor)).toEqual([FRIEND]);

      // Publicly listed — but the served representation never shows bto.
      const row = state.storage.sql
        .exec<{ restricted: number | null }>(`SELECT restricted FROM outbox`)
        .one();
      expect(row.restricted ?? 0).toBe(0);
      const page = (await (
        await instance.fetch(
          collectionRequest(username, `${iris.outbox}?page=1`),
        )
      ).json()) as { orderedItems: Record<string, unknown>[] };
      expect(page.orderedItems).toHaveLength(1);
      expect(page.orderedItems[0]!.bto).toBeUndefined();
    });
  });
});

describe("blind delivery inbox resolution", () => {
  it("resolves a bto recipient to their personal inbox, never the shared inbox", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            bto: [FRIEND],
            object: { type: "Note", content: "psst" },
          }),
        ),
      );
      await withFetch(
        async (url) => {
          const href = typeof url === "string" ? url : url.toString();
          if (href === FRIEND) {
            return new Response(
              JSON.stringify({
                id: FRIEND,
                type: "Person",
                inbox: `${FRIEND}/inbox`,
                endpoints: { sharedInbox: "https://friend.example/inbox" },
              }),
              { status: 200 },
            );
          }
          return new Response(null, { status: 404 });
        },
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__resolve`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      // With bto stripped from the payload, only the personal inbox still
      // identifies the recipient — a shared-inbox delivery would be
      // undeliverable on the receiving side.
      const delivery = state.storage.sql
        .exec<{ inbox: string; json: string }>(
          `SELECT inbox, json FROM delivery`,
        )
        .one();
      expect(delivery.inbox).toBe(`${FRIEND}/inbox`);
      expect(
        (JSON.parse(delivery.json) as Record<string, unknown>).bto,
      ).toBeUndefined();
      expect(counts(state, "pending_accept")).toBe(0);
    });
  });

  it("treats bto on the embedded object as restricted addressing", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      // AS2 addressing lives on Object as much as on Activity: a raw Create
      // carrying `bto` ONLY on its nested object must be detected as
      // restricted all the same — reading just the top level would fan this
      // out to every follower with the "blind" list intact.
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            object: {
              type: "Note",
              content: "nested secret",
              bto: [FRIEND],
            },
          }),
        ),
      );
      expect(res.status).toBe(201);

      expect(counts(state, "delivery")).toBe(0);
      const blind = blindDeliveries(state);
      expect(blind.map((d) => d.actor)).toEqual([FRIEND]);
      const object = blind[0]!.activity.object as Record<string, unknown>;
      expect(object.bto).toBeUndefined();

      const head = (await (
        await instance.fetch(collectionRequest(username, iris.outbox))
      ).json()) as Record<string, unknown>;
      expect(head.totalItems).toBe(0);
    });
  });

  it("drops a blind delivery when the actor doc has no personal inbox", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            bto: [FRIEND],
            object: { type: "Note", content: "psst" },
          }),
        ),
      );
      await withFetch(
        async (url) => {
          const href = typeof url === "string" ? url : url.toString();
          if (href === FRIEND) {
            // A malformed/atypical actor doc: shared inbox only. The resolved
            // fallback inbox IS the shared inbox, so a blind delivery has no
            // usable target — it must be dropped, never delivered shared.
            return new Response(
              JSON.stringify({
                id: FRIEND,
                type: "Person",
                endpoints: { sharedInbox: "https://friend.example/inbox" },
              }),
              { status: 200 },
            );
          }
          return new Response(null, { status: 404 });
        },
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__resolve`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      expect(counts(state, "delivery")).toBe(0);
      expect(counts(state, "pending_accept")).toBe(0);
    });
  });
});

describe("shaped-post publish (PostInput) with bto", () => {
  it("defaults a bto post to restricted addressing and queues blind delivery", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      const res = await instance.fetch(
        publishPostRequest(username, {
          kind: "note",
          content: "<p>just for the contacts</p>",
          bto: [FRIEND],
        }),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      // No implicit public/followers addressing on a blind post.
      expect(activity.to).toEqual([]);
      expect(activity.cc).toEqual([]);
      expect(activity.bto).toEqual([FRIEND]);

      expect(counts(state, "delivery")).toBe(0);
      expect(blindDeliveries(state).map((d) => d.actor)).toEqual([FRIEND]);
      const head = (await (
        await instance.fetch(collectionRequest(username, iris.outbox))
      ).json()) as Record<string, unknown>;
      expect(head.totalItems).toBe(0);
    });
  });

  it("keeps explicit public addressing alongside bto un-restricted", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollower(state);
      const res = await instance.fetch(
        publishPostRequest(username, {
          kind: "note",
          content: "<p>public, plus a direct copy</p>",
          to: [PUBLIC_AUDIENCE],
          bto: [FRIEND],
        }),
      );
      expect(res.status).toBe(201);
      expect(counts(state, "delivery")).toBe(1);
      expect(blindDeliveries(state).map((d) => d.actor)).toEqual([FRIEND]);
      const head = (await (
        await instance.fetch(collectionRequest(username, iris.outbox))
      ).json()) as Record<string, unknown>;
      expect(head.totalItems).toBe(1);
    });
  });

  it("rejects a bto entry that is not an actor IRI", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        publishPostRequest(username, {
          kind: "note",
          content: "<p>x</p>",
          bto: [PUBLIC_AUDIENCE],
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/`bto`/);
    });
  });

  it("dedupes bto recipients and ignores our own actor", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      await instance.fetch(
        publishPostRequest(username, {
          kind: "note",
          content: "<p>hi</p>",
          bto: [FRIEND, FRIEND, iris.id],
        }),
      );
      expect(blindDeliveries(state).map((d) => d.actor)).toEqual([FRIEND]);
    });
  });
});
