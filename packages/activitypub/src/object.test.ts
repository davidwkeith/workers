import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  INTERNAL_HEADERS,
  deriveIris,
  type ActivityPubEnv,
  type ForwardedConfig,
} from "./config.js";
import {
  ActivityPubLogEvent,
  METRICS_DRAIN_HEADER,
  METRICS_HEADER,
} from "./log.js";

/**
 * Branch-focused tests over the per-actor Durable Object ({@link
 * ActivityPubObject}), driving it directly with `runInDurableObject` and the
 * internal config header the front door would forward. These exercise the
 * malformed / partial / alternate-shape inbound paths — routing fallbacks, the
 * full inbox activity switch, the publish + collection seams, the SSRF-guarded
 * `resolveInbox`, and the delivery-queue drop / reschedule branches — that the
 * end-to-end `index.test.ts` happy paths leave uncovered.
 */

const testEnv = env as unknown as ActivityPubEnv;

const BASE = "https://social.example";
const REMOTE = "https://remote.example/users/alice";

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

let privateKeyPem: string;

function toPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKeyPem = toPem(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    "PRIVATE KEY",
  );
});

/** A fresh, isolated DO bound to a unique actor IRI. */
function freshUser() {
  const username = `obj-${crypto.randomUUID().slice(0, 8)}`;
  const iris = deriveIris(BASE, username);
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));
  return { username, iris, stub };
}

type Stub = ReturnType<typeof freshUser>["stub"];

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
    keyId: iris.keyId,
    ...overrides,
  };
  return JSON.stringify(config);
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

// ---------------------------------------------------------------------------
// Routing fallbacks
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("500s when the internal config header is missing", async () => {
    const { iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(new Request(iris.id));
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("missing internal config");
    });
  });

  it("serves the following collection head and a page", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'accepted', ?), (?, 'accepted', ?)`,
        `${REMOTE}/1`,
        1,
        `${REMOTE}/2`,
        2,
      );
      const head = await instance.fetch(
        new Request(iris.following, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      const headDoc = (await head.json()) as Record<string, unknown>;
      expect(headDoc.type).toBe("OrderedCollection");
      expect(headDoc.totalItems).toBe(2);

      const page = await instance.fetch(
        new Request(`${iris.following}?page=1`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      const pageDoc = (await page.json()) as Record<string, unknown>;
      expect(pageDoc.type).toBe("OrderedCollectionPage");
      expect(pageDoc.orderedItems).toEqual([`${REMOTE}/2`, `${REMOTE}/1`]);
    });
  });

  it("treats a non-numeric page parameter as page 1", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        new Request(`${iris.followers}?page=not-a-number`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.id).toBe(`${iris.followers}?page=1`);
    });
  });

  it("405s a GET to the inbox and 404s an unknown path", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const inbox = await instance.fetch(
        new Request(iris.inbox, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      expect(inbox.status).toBe(405);

      const unknown = await instance.fetch(
        new Request(`${iris.id}/does-not-exist`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      expect(unknown.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Inbox activity handling
// ---------------------------------------------------------------------------

/** A POST to the actor inbox carrying a raw body, for a direct DO call. */
function inboxRequest(username: string, body: string): Request {
  const iris = deriveIris(BASE, username);
  return new Request(iris.inbox, {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
      [INTERNAL_HEADERS.config]: cfgHeader(username),
    },
    body,
  });
}

describe("inbox handling", () => {
  it("400s on malformed JSON and on a non-object body", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const bad = await instance.fetch(inboxRequest(username, "{not json"));
      expect(bad.status).toBe(400);
      const scalar = await instance.fetch(inboxRequest(username, "123"));
      expect(scalar.status).toBe(400);
    });
  });

  it("accepts an activity with a non-string type as Unknown", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        inboxRequest(username, JSON.stringify({ type: 5, actor: REMOTE })),
      );
      expect(res.status).toBe(202);
      expect(res.headers.get("x-ap-outcome-activity")).toBe("Unknown");
    });
  });

  it("stores Create/Like activities, with or without an id", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const withId = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({
            id: "https://remote.example/c/1",
            type: "Create",
            actor: REMOTE,
            object: { type: "Note", content: "hi" },
          }),
        ),
      );
      expect(withId.status).toBe(202);

      const noId = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({ type: "Like", actor: REMOTE, object: "x" }),
        ),
      );
      expect(noId.status).toBe(202);

      const n = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox`)
        .one().n;
      expect(n).toBe(2);
    });
  });

  it("marks a following row accepted on Accept; ignores an Accept with no actor", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'pending', ?)`,
        REMOTE,
        1,
      );
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({ type: "Accept", actor: REMOTE }),
        ),
      );
      const state1 = state.storage.sql
        .exec<{
          state: string;
        }>(`SELECT state FROM following WHERE actor = ?`, REMOTE)
        .one().state;
      expect(state1).toBe("accepted");

      // No actor → nothing to update, still accepted.
      const res = await instance.fetch(
        inboxRequest(username, JSON.stringify({ type: "Accept" })),
      );
      expect(res.status).toBe(202);
    });
  });

  it("drops a follower on Delete of its actor; ignores a Delete with no object", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, NULL, ?)`,
        REMOTE,
        1,
      );
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({ type: "Delete", actor: REMOTE, object: REMOTE }),
        ),
      );
      const remaining = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM followers`)
        .one().n;
      expect(remaining).toBe(0);

      const res = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({ type: "Delete", actor: REMOTE }),
        ),
      );
      expect(res.status).toBe(202);
    });
  });

  it("ignores an Undo carrying an embedded Follow with no actor", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({ type: "Undo", object: { type: "Follow" } }),
        ),
      );
      expect(res.status).toBe(202);
    });
  });

  it("removes the following row on a Reject of our Follow", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'pending', ?)`,
        REMOTE,
        1,
      );
      const res = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({
            id: "https://remote.example/r/1",
            type: "Reject",
            actor: REMOTE,
            object: {
              type: "Follow",
              actor: `${BASE}/users/${username}`,
              object: REMOTE,
            },
          }),
        ),
      );
      expect(res.status).toBe(202);
      const remaining = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM following`)
        .one().n;
      expect(remaining).toBe(0);
    });
  });

  it("ignores a Reject whose object is not a Follow", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'accepted', ?)`,
        REMOTE,
        1,
      );
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({
            id: "https://remote.example/r/2",
            type: "Reject",
            actor: REMOTE,
            object: { type: "Like", object: "x" },
          }),
        ),
      );
      const remaining = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM following`)
        .one().n;
      expect(remaining).toBe(1);
    });
  });

  it("forwards a reply to a local post to followers (§7.1.2)", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({
            id: "https://remote.example/c/reply-1",
            type: "Create",
            actor: REMOTE,
            to: [iris.followers],
            object: {
              id: "https://remote.example/notes/reply-1",
              type: "Note",
              content: "nice post",
              inReplyTo: `${iris.outbox}/local-post-1`,
            },
          }),
        ),
      );
      expect(res.status).toBe(202);
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(queued).toBe(1);
    });
  });

  it("does not forward a reply that references no local object (§7.1.2)", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({
            id: "https://remote.example/c/reply-2",
            type: "Create",
            actor: REMOTE,
            to: [iris.followers],
            object: {
              id: "https://remote.example/notes/reply-2",
              type: "Note",
              content: "elsewhere",
              inReplyTo: "https://other.example/notes/999",
            },
          }),
        ),
      );
      expect(res.status).toBe(202);
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(queued).toBe(0);
    });
  });

  it("ignores a Follow that targets a different actor", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify({
            id: "https://remote.example/f/mis",
            type: "Follow",
            actor: REMOTE,
            object: "https://other.example/users/someone",
          }),
        ),
      );
      expect(res.status).toBe(202);
      const n = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM followers`)
        .one().n;
      expect(n).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveInbox (auto-accept path) — SSRF guard + remote-doc shapes
// ---------------------------------------------------------------------------

/** Auto-accept a Follow from `follower`, with `fetch` stubbed for the lookup. */
async function followWith(
  stub: Stub,
  username: string,
  follower: string,
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>,
): Promise<{ status: number; deliveries: number }> {
  const iris = deriveIris(BASE, username);
  return runInDurableObject(stub, async (instance, state) =>
    withFetch(fetchImpl, async () => {
      const res = await instance.fetch(
        new Request(iris.inbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username, { privateKeyPem }),
          },
          body: JSON.stringify({
            id: `https://remote.example/f/${crypto.randomUUID()}`,
            type: "Follow",
            actor: follower,
            object: iris.id,
          }),
        }),
      );
      // Inbox resolution is alarm-driven (not inline); drive it explicitly so
      // these branch tests can inspect the resulting queue state.
      await instance.fetch(
        new Request(`${iris.id}/__resolve`, {
          headers: {
            [INTERNAL_HEADERS.config]: cfgHeader(username, { privateKeyPem }),
          },
        }),
      );
      const deliveries = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      return { status: res.status, deliveries };
    }),
  );
}

describe("Follow inbox resolution stays off the inbound critical path (#220)", () => {
  it("202s a Follow without ever fetching the actor document inline", async () => {
    const { username, iris, stub } = freshUser();
    let lookups = 0;
    await runInDurableObject(stub, async (instance, state) =>
      withFetch(
        async () => {
          lookups += 1;
          throw new Error("the inbound POST must not reach outbound fetch");
        },
        async () => {
          const res = await instance.fetch(
            new Request(iris.inbox, {
              method: "POST",
              headers: {
                "content-type": "application/activity+json",
                [INTERNAL_HEADERS.config]: cfgHeader(username, {
                  privateKeyPem,
                }),
              },
              body: JSON.stringify({
                id: `https://remote.example/f/${crypto.randomUUID()}`,
                type: "Follow",
                actor: REMOTE,
                object: iris.id,
              }),
            }),
          );
          expect(res.status).toBe(202);
          expect(lookups).toBe(0);

          // The follower is recorded with its inbox still unresolved, and the
          // resolution is queued (not attempted) until the alarm-driven pass.
          const follower = state.storage.sql
            .exec<{
              inbox: string | null;
            }>(`SELECT inbox FROM followers WHERE actor = ?`, REMOTE)
            .one();
          expect(follower.inbox).toBeNull();
          const pending = state.storage.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
            .one().n;
          expect(pending).toBe(1);
          expect(lookups).toBe(0);
        },
      ),
    );
  });
});

describe("auto-Accept skips a retracted Follow/Join before resolving (#220)", () => {
  it("drops a pending Accept for a follower who Undo'd before the alarm ran, without an inbox lookup", async () => {
    const { username, iris, stub } = freshUser();
    let lookups = 0;
    await runInDurableObject(stub, async (instance, state) =>
      withFetch(
        async () => {
          lookups += 1;
          throw new Error("must not resolve the inbox of a retracted Follow");
        },
        async () => {
          await instance.fetch(
            inboxRequest(
              username,
              JSON.stringify({
                id: "https://remote.example/f/1",
                type: "Follow",
                actor: REMOTE,
                object: iris.id,
              }),
            ),
          );
          // The follower unfollows before the alarm resolves their inbox.
          await instance.fetch(
            inboxRequest(
              username,
              JSON.stringify({
                id: "https://remote.example/u/1",
                type: "Undo",
                actor: REMOTE,
                object: {
                  type: "Follow",
                  actor: REMOTE,
                  object: iris.id,
                },
              }),
            ),
          );

          const res = await instance.fetch(
            new Request(`${iris.id}/__resolve`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
          expect(res.status).toBe(200);
          expect(lookups).toBe(0);

          const pending = state.storage.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
            .one().n;
          expect(pending).toBe(0);
          const queued = state.storage.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
            .one().n;
          expect(queued).toBe(0);
        },
      ),
    );
  });

  it("drops a pending Accept for a participant who Left before the alarm ran, without an inbox lookup", async () => {
    const { username, iris, stub } = freshUser();
    const event = `${iris.id}/events/picnic`;
    let lookups = 0;
    await runInDurableObject(stub, async (instance, state) =>
      withFetch(
        async () => {
          lookups += 1;
          throw new Error("must not resolve the inbox of a retracted Join");
        },
        async () => {
          await instance.fetch(
            inboxRequest(
              username,
              JSON.stringify({
                id: "https://remote.example/j/1",
                type: "Join",
                actor: REMOTE,
                object: event,
              }),
            ),
          );
          // The participant leaves before the alarm resolves their inbox.
          await instance.fetch(
            inboxRequest(
              username,
              JSON.stringify({
                id: "https://remote.example/l/1",
                type: "Leave",
                actor: REMOTE,
                object: event,
              }),
            ),
          );

          const res = await instance.fetch(
            new Request(`${iris.id}/__resolve`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
          expect(res.status).toBe(200);
          expect(lookups).toBe(0);

          const pending = state.storage.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
            .one().n;
          expect(pending).toBe(0);
        },
      ),
    );
  });
});

describe("auto-accept resolveInbox", () => {
  it("ignores a follower whose actor IRI is an unsafe target", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(
      stub,
      username,
      "https://localhost/users/x",
      async () => new Response(null, { status: 500 }),
    );
    expect(out.status).toBe(202);
    expect(out.deliveries).toBe(0);
  });

  it("gives up when the actor lookup throws", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(stub, username, REMOTE, async () => {
      throw new Error("network down");
    });
    expect(out.deliveries).toBe(0);
  });

  it("gives up when the actor lookup is not ok", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(
      stub,
      username,
      REMOTE,
      async () => new Response("nope", { status: 404 }),
    );
    expect(out.deliveries).toBe(0);
  });

  it("gives up when the actor document is not valid JSON", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(
      stub,
      username,
      REMOTE,
      async () => new Response("<<<not json>>>", { status: 200 }),
    );
    expect(out.deliveries).toBe(0);
  });

  it("gives up when the actor document is a non-object", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(
      stub,
      username,
      REMOTE,
      async () => new Response("42", { status: 200 }),
    );
    expect(out.deliveries).toBe(0);
  });

  it("gives up when the actor document advertises no inbox", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(
      stub,
      username,
      REMOTE,
      async () => new Response(JSON.stringify({ id: REMOTE }), { status: 200 }),
    );
    expect(out.deliveries).toBe(0);
  });

  it("prefers a shared inbox from endpoints and enqueues the Accept", async () => {
    const { username, stub } = freshUser();
    const out = await followWith(stub, username, REMOTE, async (url) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === REMOTE) {
        return new Response(
          JSON.stringify({
            id: REMOTE,
            inbox: `${REMOTE}/inbox`,
            endpoints: { sharedInbox: "https://remote.example/inbox" },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    });
    expect(out.status).toBe(202);
    expect(out.deliveries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Publish (owner C2S seam)
// ---------------------------------------------------------------------------

/** A POST to the outbox, optionally flagged as an owner publish. */
function outboxRequest(
  username: string,
  body: string,
  publish: boolean,
  skipDelivery = false,
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/activity+json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
  if (skipDelivery) headers[INTERNAL_HEADERS.skipDelivery] = "1";
  return new Request(iris.outbox, { method: "POST", headers, body });
}

describe("publish endpoint", () => {
  it("403s when the publish header is not set", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(outboxRequest(username, "{}", false));
      expect(res.status).toBe(403);
    });
  });

  it("400s an owner publish with malformed JSON", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(outboxRequest(username, "{bad", true));
      expect(res.status).toBe(400);
    });
  });

  it("publishes a pre-wrapped activity unchanged at the top level", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Announce",
            object: "https://remote.example/notes/1",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.type).toBe("Announce");
      // The server mints the activity id under our outbox IRI space.
      expect(String(activity.id).startsWith(iris.outbox)).toBe(true);
    });
  });

  it("mints a server id for an owner activity, ignoring a client-supplied id", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            id: "https://attacker.example/act/forged",
            type: "Announce",
            object: "https://remote.example/notes/1",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      // §6/§3.1: the server overwrites the client id, and the Location header
      // reflects the minted id.
      expect(activity.id).not.toBe("https://attacker.example/act/forged");
      expect(String(activity.id).startsWith(iris.outbox)).toBe(true);
      expect(res.headers.get("location")).toBe(activity.id);
    });
  });

  it("assigns an id to an activity that omits one", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Create", object: { type: "Note" } }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(String(activity.id).startsWith(iris.outbox)).toBe(true);
    });
  });

  it("fans a published Note out to followers with a known inbox", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            id: "https://social.example/notes/own-id",
            type: "Note",
            content: "hello",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.type).toBe("Create");
      // The bare object kept its supplied id.
      expect((activity.object as Record<string, unknown>).id).toBe(
        "https://social.example/notes/own-id",
      );
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(queued).toBe(1);
    });
  });

  it("preserves a caller-supplied published timestamp on a bare object", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Note",
            content: "old post",
            published: "2019-03-01T12:00:00.000Z",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.published).toBe("2019-03-01T12:00:00.000Z");
      const object = activity.object as Record<string, unknown>;
      expect(object.published).toBe("2019-03-01T12:00:00.000Z");
      const row = state.storage.sql
        .exec<{ published_at: number }>(
          `SELECT published_at FROM outbox WHERE id = ?`,
          activity.id,
        )
        .one();
      expect(row.published_at).toBe(Date.parse("2019-03-01T12:00:00.000Z"));
    });
  });

  it("preserves a caller-supplied published timestamp on a pre-wrapped activity", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Announce",
            object: "https://remote.example/notes/1",
            published: "2018-01-01T00:00:00.000Z",
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.published).toBe("2018-01-01T00:00:00.000Z");
    });
  });

  it("400s an unparseable published timestamp", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Note", content: "x", published: "nope" }),
          true,
        ),
      );
      expect(res.status).toBe(400);
    });
  });

  it("skipDelivery inserts into the outbox without fan-out or arming the alarm", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Note", content: "backfilled" }),
          true,
          true,
        ),
      );
      expect(res.status).toBe(201);
      const outboxCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outboxCount).toBe(1);
      const deliveryCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(deliveryCount).toBe(0);
    });
  });

  it("skipDelivery on a Follow does not record a relationship or queue delivery", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Follow", object: REMOTE }),
          true,
          true,
        ),
      );
      expect(res.status).toBe(201);
      const followingCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM following`)
        .one().n;
      expect(followingCount).toBe(0);
      const pendingCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
        .one().n;
      expect(pendingCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Shaped post publish (`POST <actor>/publish`, fediverse interop phase 1 #274)
// ---------------------------------------------------------------------------

/** A POST to the shaped-post publish endpoint. */
function publishRequest(
  username: string,
  body: string,
  publish = true,
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
  return new Request(`${iris.id}/publish`, { method: "POST", headers, body });
}

describe("shaped post publish endpoint", () => {
  it("403s when the publish header is not set", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({ kind: "note", content: "x" }),
          false,
        ),
      );
      expect(res.status).toBe(403);
    });
  });

  it("405s a non-POST", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        new Request(`${iris.id}/publish`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      expect(res.status).toBe(405);
    });
  });

  it("400s malformed JSON and invalid PostInput with a precise reason", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      expect(
        (await instance.fetch(publishRequest(username, "{bad"))).status,
      ).toBe(400);
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({ kind: "page", content: "b" }),
        ),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/`name`/);
    });
  });

  it("publishes a media note: minted ids, outbox row, follower fan-out", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({
            kind: "note",
            content: "<p>a bird</p>",
            sensitive: true,
            attachments: [
              {
                type: "Image",
                url: "https://media.example/bird.jpg",
                mediaType: "image/jpeg",
                name: "a heron",
              },
            ],
          }),
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.type).toBe("Create");
      expect(String(activity.id).startsWith(iris.outbox)).toBe(true);
      expect(res.headers.get("location")).toBe(activity.id);
      const object = activity.object as Record<string, unknown>;
      expect(object.type).toBe("Note");
      expect(object.sensitive).toBe(true);
      expect(Array.isArray(object.attachment)).toBe(true);
      // Stored in the outbox and queued for the follower.
      const outboxed = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outboxed).toBe(1);
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(queued).toBe(1);
    });
  });

  it("publishes a titled Page carrying the community audience", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({
            kind: "page",
            content: "<p>body</p>",
            name: "A title",
            audience: "https://lemmy.example/c/birding",
          }),
        ),
      );
      expect(res.status).toBe(201);
      const activity = (await res.json()) as Record<string, unknown>;
      expect(activity.audience).toBe("https://lemmy.example/c/birding");
      const object = activity.object as Record<string, unknown>;
      expect(object.type).toBe("Page");
      expect(object.name).toBe("A title");
      expect(activity.to).toEqual([
        "https://lemmy.example/c/birding",
        "https://www.w3.org/ns/activitystreams#Public",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Inbox classification columns (fediverse interop phase 1 #274)
// ---------------------------------------------------------------------------

describe("inbox classification", () => {
  it("stores object_type and audience for a classified Create", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        new Request(iris.inbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username),
            [INTERNAL_HEADERS.signedActor]: REMOTE,
          },
          body: JSON.stringify({
            id: "https://remote.example/activities/1",
            type: "Create",
            actor: REMOTE,
            audience: "https://lemmy.example/c/birding",
            object: {
              type: "Page",
              attributedTo: REMOTE,
              name: "hello",
            },
          }),
        }),
      );
      expect(res.status).toBe(202);
      const row = state.storage.sql
        .exec<{
          object_type: string | null;
          audience: string | null;
        }>(`SELECT object_type, audience FROM inbox`)
        .one();
      expect(row.object_type).toBe("Page");
      expect(row.audience).toBe("https://lemmy.example/c/birding");
    });
  });

  it("stores NULL classification for an opaque Like", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        new Request(iris.inbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: cfgHeader(username),
            [INTERNAL_HEADERS.signedActor]: REMOTE,
          },
          body: JSON.stringify({
            id: "https://remote.example/activities/2",
            type: "Like",
            actor: REMOTE,
            object: "https://social.example/notes/1",
          }),
        }),
      );
      expect(res.status).toBe(202);
      const row = state.storage.sql
        .exec<{
          object_type: string | null;
          audience: string | null;
        }>(`SELECT object_type, audience FROM inbox`)
        .one();
      expect(row.object_type).toBeNull();
      expect(row.audience).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// FEP-1b12 group participation (fediverse interop phase 2 #275)
// ---------------------------------------------------------------------------

const GROUP = "https://lemmy.example/c/birding";
const AUTHOR = "https://lemmy.example/u/carol";

/** Seed a followed community: an accepted `following` row typed `Group`. */
function seedFollowedGroup(
  state: DurableObjectState,
  inbox: string | null = null,
): void {
  state.storage.sql.exec(
    `INSERT INTO following (actor, state, added_at, actor_type, inbox, shared_inbox)
       VALUES (?, 'accepted', 1, 'Group', ?, NULL)`,
    GROUP,
    inbox,
  );
}

/** An inbound POST of `activity` signed by `signer`, as the front door forwards it. */
function signedInboxRequest(
  username: string,
  activity: Record<string, unknown>,
  signer: string,
  overrides: Partial<ForwardedConfig> = {},
): Request {
  const iris = deriveIris(BASE, username);
  return new Request(iris.inbox, {
    method: "POST",
    headers: {
      "content-type": "application/activity+json",
      [INTERNAL_HEADERS.config]: cfgHeader(username, overrides),
      [INTERNAL_HEADERS.signedActor]: signer,
    },
    body: JSON.stringify(activity),
  });
}

/** A group announce wrapping an embedded member activity. */
function groupAnnounce(
  innerType: string,
  innerId: string,
  innerObject: Record<string, unknown> | string,
): Record<string, unknown> {
  return {
    id: `${GROUP}/activities/${crypto.randomUUID()}`,
    type: "Announce",
    actor: GROUP,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    object: {
      id: innerId,
      type: innerType,
      actor: AUTHOR,
      attributedTo: AUTHOR,
      object: innerObject,
    },
  };
}

describe("announce unwrapping (FEP-1b12)", () => {
  it("stores the inner activity with relayed_by, audience fallback, and a content-tier verify row", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state);
      const innerId = `${AUTHOR}/activities/1`;
      const before = Date.now();
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce("Create", innerId, {
            id: `${AUTHOR}/post/1`,
            type: "Page",
            name: "Herons",
            attributedTo: AUTHOR,
          }),
          GROUP,
        ),
      );
      expect(res.status).toBe(202);
      const rows = state.storage.sql
        .exec<{
          id: string;
          object_type: string | null;
          audience: string | null;
          relayed_by: string | null;
          verify_state: string | null;
        }>(
          `SELECT id, object_type, audience, relayed_by, verify_state FROM inbox ORDER BY seq`,
        )
        .toArray();
      // Outer Announce + unwrapped inner Create.
      expect(rows).toHaveLength(2);
      const inner = rows.find((r) => r.id === innerId);
      expect(inner).toBeDefined();
      expect(inner?.relayed_by).toBe(GROUP);
      expect(inner?.verify_state).toBe("pending");
      expect(inner?.object_type).toBe("Page");
      // No audience on the inner activity ⇒ the relaying group is recorded.
      expect(inner?.audience).toBe(GROUP);
      // Content tier: the verify row is due immediately.
      const verify = state.storage.sql
        .exec<{
          target: string;
          expect: string;
          next_at: number;
        }>(`SELECT target, expect, next_at FROM verify_queue`)
        .one();
      expect(verify.target).toBe(`${AUTHOR}/post/1`);
      expect(verify.expect).toBe("present");
      expect(verify.next_at).toBeLessThanOrEqual(Date.now());
      expect(verify.next_at).toBeGreaterThanOrEqual(before - 1000);
    });
  });

  it("defers relayed votes to the batched sweep in tiered mode", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state);
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce(
            "Like",
            `${AUTHOR}/activities/like-1`,
            `${AUTHOR}/post/1`,
          ),
          GROUP,
        ),
      );
      expect(res.status).toBe(202);
      const verify = state.storage.sql
        .exec<{
          target: string;
          next_at: number;
        }>(`SELECT target, next_at FROM verify_queue`)
        .one();
      // Votes verify at the activity id, after the sweep delay.
      expect(verify.target).toBe(`${AUTHOR}/activities/like-1`);
      expect(verify.next_at).toBeGreaterThan(Date.now() + 60_000);
    });
  });

  it("queues no verification in off mode but still marks provenance", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state);
      await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce("Create", `${AUTHOR}/activities/2`, {
            id: `${AUTHOR}/post/2`,
            type: "Note",
            attributedTo: AUTHOR,
          }),
          GROUP,
          { verifyRelayedObjects: "off" },
        ),
      );
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM verify_queue`)
        .one().n;
      expect(queued).toBe(0);
      const inner = state.storage.sql
        .exec<{
          relayed_by: string | null;
          verify_state: string | null;
        }>(
          `SELECT relayed_by, verify_state FROM inbox WHERE id = ?`,
          `${AUTHOR}/activities/2`,
        )
        .one();
      expect(inner.relayed_by).toBe(GROUP);
      expect(inner.verify_state).toBe("pending");
    });
  });

  it("does not unwrap when the announcer is not a followed Group", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      // No following row at all.
      await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce("Create", `${AUTHOR}/activities/3`, {
            id: `${AUTHOR}/post/3`,
            type: "Note",
            attributedTo: AUTHOR,
          }),
          GROUP,
        ),
      );
      const rows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox`)
        .one().n;
      // Only the outer Announce stored.
      expect(rows).toBe(1);
    });
  });

  it("dedups on the inner activity id across repeated announces", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state);
      const innerId = `${AUTHOR}/activities/4`;
      const inner = {
        id: `${AUTHOR}/post/4`,
        type: "Note",
        attributedTo: AUTHOR,
      };
      await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce("Create", innerId, inner),
          GROUP,
        ),
      );
      await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce("Create", innerId, inner),
          GROUP,
        ),
      );
      const copies = state.storage.sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM inbox WHERE id = ?`, innerId)
        .one().n;
      expect(copies).toBe(1);
    });
  });
});

describe("actor/signer mismatch (impersonation guard)", () => {
  it("403s when the activity's actor differs from the verified signer", async () => {
    const { username, stub } = freshUser();
    const mismatched = {
      id: `${REMOTE}/activities/mismatch-1`,
      type: "Follow",
      actor: "https://impostor.example/users/eve",
      object: REMOTE,
    };
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        signedInboxRequest(username, mismatched, REMOTE),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe(
        "Activity actor does not match the signing actor",
      );
    });
  });
});

describe("dislike", () => {
  it("stores an inbound Dislike like a Like", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${REMOTE}/activities/dislike-1`,
            type: "Dislike",
            actor: REMOTE,
            object: "https://social.example/notes/1",
          },
          REMOTE,
        ),
      );
      expect(res.status).toBe(202);
      const stored = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox`)
        .one().n;
      expect(stored).toBe(1);
    });
  });
});

describe("outbound relationship activities", () => {
  it("records a pending following row and targets the Follow at the followee", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      // A follower with a known inbox must NOT receive the Follow.
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Follow", object: GROUP }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const following = state.storage.sql
        .exec<{
          state: string;
        }>(`SELECT state FROM following WHERE actor = ?`, GROUP)
        .one();
      expect(following.state).toBe("pending");
      const pending = state.storage.sql
        .exec<{
          kind: string;
          actor: string;
        }>(`SELECT kind, actor FROM pending_accept`)
        .one();
      expect(pending.kind).toBe("deliver");
      expect(pending.actor).toBe(GROUP);
      const fanout = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(fanout).toBe(0);
    });
  });

  it("drops the following row on Undo(Follow) and delivers the Undo", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state);
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Undo",
            object: { type: "Follow", object: GROUP },
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const rows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM following`)
        .one().n;
      expect(rows).toBe(0);
      const pending = state.storage.sql
        .exec<{
          kind: string;
          actor: string;
        }>(`SELECT kind, actor FROM pending_accept`)
        .one();
      expect(pending.kind).toBe("deliver");
      expect(pending.actor).toBe(GROUP);
    });
  });
});

describe("outbound vote delivery (Like/Dislike audience)", () => {
  it("delivers a Like to the named community's inbox when known", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state, `${GROUP}/inbox`);
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Like",
            object: `${GROUP}/posts/1`,
            audience: GROUP,
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const targets = state.storage.sql
        .exec<{ inbox: string }>(`SELECT inbox FROM delivery`)
        .toArray()
        .map((r) => r.inbox);
      expect(targets).toEqual([`${GROUP}/inbox`]);
    });
  });

  it("delivers a Dislike to the named community's shared inbox when known", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at, actor_type, inbox, shared_inbox)
           VALUES (?, 'accepted', 1, 'Group', NULL, ?)`,
        GROUP,
        `${GROUP}/shared-inbox`,
      );
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Dislike",
            object: `${GROUP}/posts/1`,
            audience: GROUP,
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const targets = state.storage.sql
        .exec<{ inbox: string }>(`SELECT inbox FROM delivery`)
        .toArray()
        .map((r) => r.inbox);
      expect(targets).toEqual([`${GROUP}/shared-inbox`]);
    });
  });

  it("queues an alarm-resolved delivery when the community inbox is unknown", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Like",
            object: `${GROUP}/posts/1`,
            audience: GROUP,
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const pending = state.storage.sql
        .exec<{
          kind: string;
          actor: string;
        }>(`SELECT kind, actor FROM pending_accept`)
        .one();
      expect(pending.kind).toBe("deliver");
      expect(pending.actor).toBe(GROUP);
    });
  });

  it("still fans out to followers, in addition to the audience delivery", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        REMOTE,
        `${REMOTE}/inbox`,
        1,
      );
      seedFollowedGroup(state, `${GROUP}/inbox`);
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Like",
            object: `${GROUP}/posts/1`,
            audience: GROUP,
          }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const targets = state.storage.sql
        .exec<{ inbox: string }>(`SELECT inbox FROM delivery`)
        .toArray()
        .map((r) => r.inbox)
        .sort();
      expect(targets).toEqual([`${GROUP}/inbox`, `${REMOTE}/inbox`].sort());
    });
  });

  it("does not deliver anywhere extra when no audience is given (only followers)", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({ type: "Like", object: `${GROUP}/posts/1` }),
          true,
        ),
      );
      expect(res.status).toBe(201);
      const rows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
        .one().n;
      expect(rows).toBe(0);
      const delivered = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(delivered).toBe(0);
    });
  });
});

describe("community post delivery", () => {
  it("delivers directly when the group inbox is known", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state, `${GROUP}/inbox`);
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({
            kind: "page",
            content: "<p>body</p>",
            name: "Title",
            audience: GROUP,
          }),
        ),
      );
      expect(res.status).toBe(201);
      const targets = state.storage.sql
        .exec<{ inbox: string }>(`SELECT inbox FROM delivery`)
        .toArray()
        .map((r) => r.inbox);
      expect(targets).toEqual([`${GROUP}/inbox`]);
    });
  });

  it("queues an alarm-resolved delivery when the group inbox is unknown", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        publishRequest(
          username,
          JSON.stringify({
            kind: "page",
            content: "<p>body</p>",
            name: "Title",
            audience: GROUP,
          }),
        ),
      );
      expect(res.status).toBe(201);
      const pending = state.storage.sql
        .exec<{
          kind: string;
          actor: string;
        }>(`SELECT kind, actor FROM pending_accept`)
        .one();
      expect(pending.kind).toBe("deliver");
      expect(pending.actor).toBe(GROUP);
    });
  });
});

const MODERATOR = "https://mod.example/users/zed";

describe("Group actor hosting (#376)", () => {
  it("treats a Join targeting the Group itself as a membership request, not an event RSVP", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${AUTHOR}/activities/join-1`,
            type: "Join",
            actor: AUTHOR,
            object: iris.id,
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(202);
      const followers = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM followers WHERE actor = ?`,
          AUTHOR,
        )
        .one().n;
      expect(followers).toBe(1);
      const attendees = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM attendees`)
        .one().n;
      expect(attendees).toBe(0);
    });
  });

  it("still treats a Join targeting an owned event as a calendar RSVP when hosting a Group", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const event = `${iris.id}/events/1`;
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${AUTHOR}/activities/join-2`,
            type: "Join",
            actor: AUTHOR,
            object: event,
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(202);
      const followers = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM followers`)
        .one().n;
      expect(followers).toBe(0);
      const attendees = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM attendees WHERE event = ? AND actor = ?`,
          event,
          AUTHOR,
        )
        .one().n;
      expect(attendees).toBe(1);
    });
  });

  it("treats a Leave targeting the Group itself as an unfollow", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, NULL, ?)`,
        AUTHOR,
        1,
      );
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${AUTHOR}/activities/leave-1`,
            type: "Leave",
            actor: AUTHOR,
            object: iris.id,
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(202);
      const followers = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM followers`)
        .one().n;
      expect(followers).toBe(0);
    });
  });

  it("wraps a member's Create in a Group-authored Announce and fans it out to the membership", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        AUTHOR,
        `${AUTHOR}/inbox`,
        1,
      );
      const innerId = `${AUTHOR}/activities/post-1`;
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: innerId,
            type: "Create",
            actor: AUTHOR,
            object: {
              id: `${innerId}/object`,
              type: "Note",
              attributedTo: AUTHOR,
              content: "hi",
            },
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(202);
      const outboxRows = state.storage.sql
        .exec<{ json: string }>(`SELECT json FROM outbox`)
        .toArray();
      expect(outboxRows).toHaveLength(1);
      const announce = JSON.parse(outboxRows[0]!.json) as Record<
        string,
        unknown
      >;
      expect(announce.type).toBe("Announce");
      expect(announce.actor).toBe(iris.id);
      expect((announce.object as { id: string }).id).toBe(innerId);
      const deliveries = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(deliveries).toBe(1);
    });
  });

  it("does not announce a non-member's post", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${AUTHOR}/activities/post-2`,
            type: "Create",
            actor: AUTHOR,
            object: {
              id: `${AUTHOR}/activities/post-2/object`,
              type: "Note",
              content: "hi",
            },
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(202);
      const outbox = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outbox).toBe(0);
    });
  });

  it("rejects any activity from a banned actor", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO banned (actor, banned_at) VALUES (?, ?)`,
        AUTHOR,
        1,
      );
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${AUTHOR}/f/banned-1`,
            type: "Follow",
            actor: AUTHOR,
            object: iris.id,
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(403);
    });
  });

  it("bans a member via a moderator-signed Remove targeting followers", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, NULL, ?)`,
        AUTHOR,
        1,
      );
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${MODERATOR}/activities/remove-1`,
            type: "Remove",
            actor: MODERATOR,
            object: AUTHOR,
            target: iris.followers,
          },
          MODERATOR,
          { actorType: "Group", moderators: [MODERATOR] },
        ),
      );
      expect(res.status).toBe(202);
      const followers = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM followers`)
        .one().n;
      expect(followers).toBe(0);
      const banned = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM banned WHERE actor = ?`,
          AUTHOR,
        )
        .one().n;
      expect(banned).toBe(1);
    });
  });

  it("ignores a Remove from an actor not on the moderator list", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, NULL, ?)`,
        AUTHOR,
        1,
      );
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${MODERATOR}/activities/remove-2`,
            type: "Remove",
            actor: MODERATOR,
            object: AUTHOR,
            target: iris.followers,
          },
          MODERATOR,
          { actorType: "Group", moderators: [] },
        ),
      );
      expect(res.status).toBe(202);
      const followers = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM followers`)
        .one().n;
      expect(followers).toBe(1);
    });
  });

  it("un-announces a member post via a moderator-signed Remove targeting the outbox", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        AUTHOR,
        `${AUTHOR}/inbox`,
        1,
      );
      const announceId = `${iris.outbox}/announce-1`;
      const innerId = `${AUTHOR}/activities/post-3`;
      const announce = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: announceId,
        type: "Announce",
        actor: iris.id,
        object: {
          id: innerId,
          type: "Create",
          actor: AUTHOR,
          object: { id: `${innerId}/object`, type: "Note" },
        },
      };
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        announceId,
        JSON.stringify(announce),
        1,
      );
      state.storage.sql.exec(
        `INSERT INTO inbox (id, json, received_at) VALUES (?, ?, ?)`,
        innerId,
        JSON.stringify(announce.object),
        1,
      );

      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${MODERATOR}/activities/remove-3`,
            type: "Remove",
            actor: MODERATOR,
            object: announceId,
            target: iris.outbox,
          },
          MODERATOR,
          { actorType: "Group", moderators: [MODERATOR] },
        ),
      );
      expect(res.status).toBe(202);
      const outboxCount = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`)
        .one().n;
      expect(outboxCount).toBe(0);
      const removedAt = state.storage.sql
        .exec<{
          removed_at: number | null;
        }>(`SELECT removed_at FROM inbox WHERE id = ?`, innerId)
        .one().removed_at;
      expect(removedAt).not.toBeNull();
      const deliveryRow = state.storage.sql
        .exec<{ json: string }>(`SELECT json FROM delivery`)
        .one();
      const undo = JSON.parse(deliveryRow.json) as Record<string, unknown>;
      expect(undo.type).toBe("Undo");
      expect((undo.object as { id: string }).id).toBe(announceId);
    });
  });

  it("records membership from a Join addressed via `target` alone, not just `object`", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const res = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${AUTHOR}/activities/join-3`,
            type: "Join",
            actor: AUTHOR,
            target: iris.id,
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(res.status).toBe(202);
      const followers = state.storage.sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM followers WHERE actor = ?`, AUTHOR)
        .one().n;
      expect(followers).toBe(1);
    });
  });

  it("excludes a moderator-removed post from __inbox and __client/timeline reads", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        AUTHOR,
        `${AUTHOR}/inbox`,
        1,
      );
      const innerId = `${AUTHOR}/activities/post-4`;
      const create = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: innerId,
            type: "Create",
            actor: AUTHOR,
            object: {
              id: `${innerId}/object`,
              type: "Note",
              attributedTo: AUTHOR,
              content: "hi",
            },
          },
          AUTHOR,
          { actorType: "Group" },
        ),
      );
      expect(create.status).toBe(202);

      const announceId = state.storage.sql
        .exec<{ id: string }>(`SELECT id FROM outbox`)
        .one().id;

      const removed = await instance.fetch(
        signedInboxRequest(
          username,
          {
            id: `${MODERATOR}/activities/remove-4`,
            type: "Remove",
            actor: MODERATOR,
            object: announceId,
            target: iris.outbox,
          },
          MODERATOR,
          { actorType: "Group", moderators: [MODERATOR] },
        ),
      );
      expect(removed.status).toBe(202);

      const listed = await instance.fetch(
        new Request(`${iris.id}/__inbox`, {
          headers: {
            [INTERNAL_HEADERS.config]: cfgHeader(username),
            [INTERNAL_HEADERS.internal]: "1",
          },
        }),
      );
      const listedBody = (await listed.json()) as {
        total: number;
        items: unknown[];
      };
      expect(listedBody.total).toBe(0);
      expect(listedBody.items).toHaveLength(0);

      const timeline = await instance.fetch(
        clientRequest(username, "/__client/timeline?limit=10"),
      );
      const timelineBody = (await timeline.json()) as { items: unknown[] };
      expect(timelineBody.items).toHaveLength(0);
    });
  });
});

describe("follow-target typing and backfill", () => {
  it("records actor_type/inboxes when a queued delivery resolves, and delivers", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'pending', 1)`,
        GROUP,
      );
      state.storage.sql.exec(
        `INSERT INTO pending_accept (kind, actor, event, json, attempts, next_at)
           VALUES ('deliver', ?, NULL, '{"type":"Follow"}', 0, 0)`,
        GROUP,
      );
      await withFetch(
        async (url) => {
          expect(String(url)).toBe(GROUP);
          return new Response(
            JSON.stringify({
              id: GROUP,
              type: "Group",
              inbox: `${GROUP}/inbox`,
              endpoints: { sharedInbox: "https://lemmy.example/inbox" },
            }),
            { status: 200 },
          );
        },
        async () => {
          const res = await instance.fetch(
            new Request(`${iris.id}/__resolve`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
          expect(res.status).toBe(200);
        },
      );
      const row = state.storage.sql
        .exec<{
          actor_type: string | null;
          inbox: string | null;
          shared_inbox: string | null;
        }>(
          `SELECT actor_type, inbox, shared_inbox FROM following WHERE actor = ?`,
          GROUP,
        )
        .one();
      expect(row.actor_type).toBe("Group");
      expect(row.shared_inbox).toBe("https://lemmy.example/inbox");
      const delivery = state.storage.sql
        .exec<{ inbox: string }>(`SELECT inbox FROM delivery`)
        .one();
      expect(delivery.inbox).toBe("https://lemmy.example/inbox");
    });
  });

  it("lazily backfills a NULL actor_type following row without delivering", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, 'accepted', 1)`,
        REMOTE,
      );
      await withFetch(
        async () =>
          new Response(
            JSON.stringify({
              id: REMOTE,
              type: "Person",
              inbox: `${REMOTE}/inbox`,
            }),
            { status: 200 },
          ),
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__resolve`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      const row = state.storage.sql
        .exec<{
          actor_type: string | null;
        }>(`SELECT actor_type FROM following WHERE actor = ?`, REMOTE)
        .one();
      expect(row.actor_type).toBe("Person");
      const deliveries = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(deliveries).toBe(0);
      const leftover = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_accept`)
        .one().n;
      expect(leftover).toBe(0);
    });
  });
});

describe("relayed-object verification", () => {
  /** Store a relayed row + verify_queue entry via a real announce unwrap. */
  async function seedRelayed(
    instance: { fetch(req: Request): Promise<Response> },
    state: DurableObjectState,
    username: string,
  ): Promise<string> {
    seedFollowedGroup(state);
    const innerId = `${AUTHOR}/activities/v1`;
    await instance.fetch(
      signedInboxRequest(
        username,
        groupAnnounce("Create", innerId, {
          id: `${AUTHOR}/post/v1`,
          type: "Note",
          attributedTo: AUTHOR,
        }),
        GROUP,
      ),
    );
    return innerId;
  }

  it("marks the row verified when the origin serves the object", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const innerId = await seedRelayed(instance, state, username);
      await withFetch(
        async (url) => {
          expect(String(url)).toBe(`${AUTHOR}/post/v1`);
          return new Response(
            JSON.stringify({ id: `${AUTHOR}/post/v1`, type: "Note" }),
            { status: 200 },
          );
        },
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__deliver`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      const row = state.storage.sql
        .exec<{
          verify_state: string | null;
        }>(`SELECT verify_state FROM inbox WHERE id = ?`, innerId)
        .one();
      expect(row.verify_state).toBe("verified");
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM verify_queue`)
        .one().n;
      expect(queued).toBe(0);
    });
  });

  it("deletes a refuted relayed row when the origin answers 404", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const innerId = await seedRelayed(instance, state, username);
      await withFetch(
        async () => new Response("gone", { status: 404 }),
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__deliver`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      const copies = state.storage.sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM inbox WHERE id = ?`, innerId)
        .one().n;
      expect(copies).toBe(0);
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM verify_queue`)
        .one().n;
      expect(queued).toBe(0);
    });
  });

  it("treats a 2xx non-JSON body (CDN error page) as transient, never a refutation", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const innerId = await seedRelayed(instance, state, username);
      await withFetch(
        async () =>
          new Response("<html>challenge</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__deliver`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      // Row survives, still pending, and the verify row backs off.
      const row = state.storage.sql
        .exec<{
          verify_state: string | null;
        }>(`SELECT verify_state FROM inbox WHERE id = ?`, innerId)
        .one();
      expect(row.verify_state).toBe("pending");
      const verify = state.storage.sql
        .exec<{ attempts: number }>(`SELECT attempts FROM verify_queue`)
        .one();
      expect(verify.attempts).toBe(1);
    });
  });

  it("keeps a relayed vote pending when its IRI 404s (inconclusive, not refuted)", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedFollowedGroup(state);
      const voteId = `${AUTHOR}/activities/like-404`;
      await instance.fetch(
        signedInboxRequest(
          username,
          groupAnnounce("Like", voteId, `${AUTHOR}/post/1`),
          GROUP,
          // Immediate mode so the vote is due without waiting for the sweep.
          { verifyRelayedObjects: "immediate" },
        ),
      );
      await withFetch(
        async () => new Response("not here", { status: 404 }),
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__deliver`, {
              headers: {
                [INTERNAL_HEADERS.config]: cfgHeader(username, {
                  verifyRelayedObjects: "immediate",
                }),
              },
            }),
          );
        },
      );
      // The vote row survives as provisional; verification simply stops.
      const copies = state.storage.sql
        .exec<{
          verify_state: string | null;
        }>(`SELECT verify_state FROM inbox WHERE id = ?`, voteId)
        .one();
      expect(copies.verify_state).toBe("pending");
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM verify_queue`)
        .one().n;
      expect(queued).toBe(0);
    });
  });

  it("reschedules on a transient origin failure and leaves the row pending", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const innerId = await seedRelayed(instance, state, username);
      await withFetch(
        async () => new Response("busy", { status: 503 }),
        async () => {
          await instance.fetch(
            new Request(`${iris.id}/__deliver`, {
              headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
            }),
          );
        },
      );
      const row = state.storage.sql
        .exec<{
          verify_state: string | null;
        }>(`SELECT verify_state FROM inbox WHERE id = ?`, innerId)
        .one();
      expect(row.verify_state).toBe("pending");
      const verify = state.storage.sql
        .exec<{
          attempts: number;
          next_at: number;
        }>(`SELECT attempts, next_at FROM verify_queue`)
        .one();
      expect(verify.attempts).toBe(1);
      expect(verify.next_at).toBeGreaterThan(Date.now());
    });
  });
});

// ---------------------------------------------------------------------------
// Delivery queue: drop, block, reschedule
// ---------------------------------------------------------------------------

/** Seed one delivery row pointing at `inbox`. `next_at` 0 ⇒ always due. */
function seedDelivery(state: DurableObjectState, inbox: string): void {
  state.storage.sql.exec(
    `INSERT INTO delivery (inbox, json, attempts, next_at) VALUES (?, '{}', 0, 0)`,
    inbox,
  );
}

function deliveryCount(state: DurableObjectState): number {
  return state.storage.sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
    .one().n;
}

/**
 * An internal request that opts in to draining the DO's pending counter
 * deltas, as every front-door-forwarded request does (see handler.ts).
 */
function drainRequest(
  username: string,
  iris: ReturnType<typeof deriveIris>,
): Request {
  return new Request(`${iris.id}/__stats`, {
    headers: {
      [INTERNAL_HEADERS.config]: cfgHeader(username),
      [METRICS_DRAIN_HEADER]: "1",
    },
  });
}

/** A request to the internal `__deliver` route that runs one delivery pass. */
function deliverRequest(
  username: string,
  overrides: Partial<ForwardedConfig>,
): Request {
  const iris = deriveIris(BASE, username);
  return new Request(`${iris.id}/__deliver`, {
    headers: { [INTERNAL_HEADERS.config]: cfgHeader(username, overrides) },
  });
}

describe("delivery queue", () => {
  it("drops a row when no signing key is configured", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedDelivery(state, `${REMOTE}/inbox`);
      const res = await instance.fetch(deliverRequest(username, {})); // no key
      expect(((await res.json()) as { processed: number }).processed).toBe(1);
      expect(deliveryCount(state)).toBe(0);
    });
  });

  it("drops a row whose target is blocked by the SSRF guard", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedDelivery(state, "https://localhost/inbox");
      await instance.fetch(deliverRequest(username, { privateKeyPem }));
      expect(deliveryCount(state)).toBe(0);
    });
  });

  it("reschedules with an incremented attempt when signing fails", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedDelivery(state, `${REMOTE}/inbox`);
      // A non-PEM key makes signRequest throw a non-blocked error → reschedule.
      await instance.fetch(
        deliverRequest(username, { privateKeyPem: "not-a-real-key" }),
      );
      const row = state.storage.sql
        .exec<{ attempts: number }>(`SELECT attempts FROM delivery LIMIT 1`)
        .toArray()[0];
      expect(row?.attempts).toBe(1);
    });
  });

  it("drops a row once it exhausts its attempt budget", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      seedDelivery(state, `${REMOTE}/inbox`);
      await instance.fetch(
        deliverRequest(username, {
          privateKeyPem: "not-a-real-key",
          deliveryMaxAttempts: 1,
        }),
      );
      expect(deliveryCount(state)).toBe(0);
    });
  });

  it("honors the persisted retry policy on a cold alarm with no live config", async () => {
    const { iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const put = (k: string, v: string) =>
        sql.exec(
          `INSERT INTO kv (k, v) VALUES (?, ?)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          k,
          v,
        );
      put("keyId", iris.keyId);
      put("privateKeyPem", privateKeyPem);
      put("deliveryMaxAttempts", "8");
      put("deliveryBaseDelayMs", "60000");
      seedDelivery(state, `${REMOTE}/inbox`);

      // No prior fetch → `#config` is null, so the policy is read from `kv`.
      const original = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response("busy", { status: 503 })) as unknown as typeof fetch;
      try {
        await instance.alarm();
      } finally {
        globalThis.fetch = original;
      }

      const row = sql
        .exec<{ attempts: number }>(`SELECT attempts FROM delivery LIMIT 1`)
        .toArray()[0];
      expect(row?.attempts).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Delivery outcome logging (#330): alarm-driven delivery has no HTTP response
// to hang the front door's x-ap-outcome header off, so these go straight to
// console.info/warn/error — this is what `wrangler tail` captures. Mirrors
// @dwk/log's consoleLogger record shape ({ level, event, time, ...fields })
// and the spec/observability.md severity table (a retry or a blocked SSRF
// attempt is `warn`; only a permanently-dropped delivery is `error`).
// ---------------------------------------------------------------------------

/** Parse a `#logDelivery` line, asserting `time` is a real timestamp. */
function parseLogLine(raw: string): Record<string, unknown> {
  const line = JSON.parse(raw) as Record<string, unknown>;
  expect(typeof line.time).toBe("string");
  expect(new Date(line.time as string).toString()).not.toBe("Invalid Date");
  const { time: _time, ...rest } = line;
  return rest;
}

describe("delivery outcome logging", () => {
  it("logs a successful delivery via console.info at info level", async () => {
    const { username, stub } = freshUser();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) =>
        withFetch(
          async () => new Response(null, { status: 202 }),
          async () => {
            seedDelivery(state, `${REMOTE}/inbox`);
            await instance.fetch(deliverRequest(username, { privateKeyPem }));
          },
        ),
      );
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(parseLogLine(infoSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: "info",
        event: ActivityPubLogEvent.DeliverySucceeded,
        targetHost: "remote.example",
        status: 202,
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("logs a permanently-failed delivery via console.error at error level, dropped", async () => {
    const { username, stub } = freshUser();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) =>
        withFetch(
          async () => new Response("nope", { status: 404 }),
          async () => {
            seedDelivery(state, `${REMOTE}/inbox`);
            await instance.fetch(deliverRequest(username, { privateKeyPem }));
          },
        ),
      );
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(parseLogLine(errorSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: "error",
        event: ActivityPubLogEvent.DeliveryFailed,
        targetHost: "remote.example",
        status: 404,
        attempts: 1,
        dropped: true,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a retryable delivery failure via console.warn at warn level, not dropped", async () => {
    const { username, stub } = freshUser();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) =>
        withFetch(
          async () => new Response("busy", { status: 503 }),
          async () => {
            seedDelivery(state, `${REMOTE}/inbox`);
            await instance.fetch(deliverRequest(username, { privateKeyPem }));
          },
        ),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(parseLogLine(warnSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: "warn",
        event: ActivityPubLogEvent.DeliveryFailed,
        targetHost: "remote.example",
        status: 503,
        attempts: 1,
        dropped: false,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs an SSRF-blocked delivery target via console.warn at warn level", async () => {
    const { username, stub } = freshUser();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) => {
        seedDelivery(state, "https://localhost/inbox");
        await instance.fetch(deliverRequest(username, { privateKeyPem }));
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(parseLogLine(warnSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: "warn",
        event: ActivityPubLogEvent.DeliveryBlocked,
        targetHost: "localhost",
        reason: "blocked_host",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("accumulates a counter delta per outcome and drains it on an opted-in request", async () => {
    const { username, iris, stub } = freshUser();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) => {
        await withFetch(
          async () => new Response(null, { status: 202 }),
          async () => {
            // Two identical outcomes coalesce into one delta with n = 2.
            seedDelivery(state, `${REMOTE}/inbox`);
            seedDelivery(state, `${REMOTE}/inbox`);
            await instance.fetch(deliverRequest(username, { privateKeyPem }));
          },
        );
        const drained = await instance.fetch(drainRequest(username, iris));
        expect(JSON.parse(drained.headers.get(METRICS_HEADER) ?? "")).toEqual([
          {
            event: ActivityPubLogEvent.DeliverySucceeded,
            fields: { status: 202, targetHost: "remote.example" },
            n: 2,
          },
        ]);
        // Drained deltas are gone: the next drain carries nothing.
        const again = await instance.fetch(drainRequest(username, iris));
        expect(again.headers.get(METRICS_HEADER)).toBeNull();
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("retains counter deltas across a request that does not opt in to drain", async () => {
    const { username, iris, stub } = freshUser();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) => {
        seedDelivery(state, "https://localhost/inbox");
        await instance.fetch(deliverRequest(username, { privateKeyPem }));
        // A plain internal request (no drain header) must neither carry nor
        // consume the deltas.
        const plain = await instance.fetch(
          new Request(`${iris.id}/__stats`, {
            headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
          }),
        );
        expect(plain.headers.get(METRICS_HEADER)).toBeNull();
        const drained = await instance.fetch(drainRequest(username, iris));
        expect(JSON.parse(drained.headers.get(METRICS_HEADER) ?? "")).toEqual([
          {
            event: ActivityPubLogEvent.DeliveryBlocked,
            fields: { reason: "blocked_host", targetHost: "localhost" },
            n: 1,
          },
        ]);
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("__stats includes followers, following, and statuses counts", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      // Seed 1 follower
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        `${REMOTE}/actor`,
        `${REMOTE}/inbox`,
        1,
      );
      // Seed 1 accepted following
      state.storage.sql.exec(
        `INSERT INTO following (actor, state, added_at) VALUES (?, ?, ?)`,
        `${REMOTE}/actor2`,
        "accepted",
        1,
      );
      // Create 1 outbox entry via publish
      const publishRes = await instance.fetch(
        outboxRequest(
          username,
          JSON.stringify({
            type: "Create",
            object: { type: "Note", content: "test" },
          }),
          true,
        ),
      );
      expect(publishRes.status).toBe(201);

      // Call __stats and verify counts
      const statsRes = await instance.fetch(
        new Request(`${iris.id}/__stats`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      const body = (await statsRes.json()) as Record<string, number>;
      expect(body.followers).toBe(1);
      expect(body.following).toBe(1);
      expect(body.statuses).toBe(1);
      expect(body.users).toBe(1);
      expect(body.localPosts).toBe(1);
    });
  });

  it("tallies into the overflow counter at the pending-metrics cardinality cap", async () => {
    const { username, stub } = freshUser();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runInDurableObject(stub, async (instance, state) => {
        for (let i = 0; i < 256; i++) {
          state.storage.sql.exec(
            `INSERT INTO pending_metrics (event, fields, n) VALUES (?, '{}', 1)`,
            `filler.${i}`,
          );
        }
        await withFetch(
          async () => new Response(null, { status: 202 }),
          async () => {
            seedDelivery(state, `${REMOTE}/inbox`);
            await instance.fetch(deliverRequest(username, { privateKeyPem }));
          },
        );
        const overflow = state.storage.sql
          .exec<{
            n: number;
          }>(
            `SELECT n FROM pending_metrics WHERE event = ?`,
            ActivityPubLogEvent.MetricsOverflow,
          )
          .toArray();
        expect(overflow).toEqual([{ n: 1 }]);
        const succeeded = state.storage.sql
          .exec<{
            n: number;
          }>(
            `SELECT COUNT(*) AS n FROM pending_metrics WHERE event = ?`,
            ActivityPubLogEvent.DeliverySucceeded,
          )
          .one().n;
        expect(succeeded).toBe(0);
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("splits a delta larger than the drain budget across successive drains", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO pending_metrics (event, fields, n) VALUES (?, '{}', 300)`,
        ActivityPubLogEvent.DeliverySucceeded,
      );
      const first = await instance.fetch(drainRequest(username, iris));
      expect(JSON.parse(first.headers.get(METRICS_HEADER) ?? "")).toEqual([
        { event: ActivityPubLogEvent.DeliverySucceeded, fields: {}, n: 256 },
      ]);
      const second = await instance.fetch(drainRequest(username, iris));
      expect(JSON.parse(second.headers.get(METRICS_HEADER) ?? "")).toEqual([
        { event: ActivityPubLogEvent.DeliverySucceeded, fields: {}, n: 44 },
      ]);
      const third = await instance.fetch(drainRequest(username, iris));
      expect(third.headers.get(METRICS_HEADER)).toBeNull();
    });
  });

  it("logs a pending-accept inbox resolution failure via console.warn, not dropped", async () => {
    const { username, stub } = freshUser();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await followWith(
        stub,
        username,
        REMOTE,
        async () => new Response(null, { status: 500 }),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(parseLogLine(warnSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: "warn",
        event: ActivityPubLogEvent.DeliveryFailed,
        targetHost: "remote.example",
        status: 0,
        attempts: 1,
        dropped: false,
        stage: "resolve",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// __client/timeline, __client/notifications, __client/entry (Mastodon client
// API phase 2, #349): owner-only internal reads over `inbox`, gated exactly
// like `__inbox`/`__following` (INTERNAL_HEADERS.internal !== "1" -> 404).
// ---------------------------------------------------------------------------

/** A Like activity from REMOTE targeting an opaque local object IRI. */
function likeActivity(
  id: string,
  object = "https://social.example/notes/1",
): Record<string, unknown> {
  return { id, type: "Like", actor: REMOTE, object };
}

/** A Create(Note) activity from REMOTE, attributed to itself (a followed post). */
function createNoteActivity(
  id: string,
  content = "hello",
): Record<string, unknown> {
  return {
    id,
    type: "Create",
    actor: REMOTE,
    object: { type: "Note", content, attributedTo: REMOTE },
  };
}

/** An Announce activity from REMOTE wrapping a bare-IRI object. */
function announceActivity(id: string, object: string): Record<string, unknown> {
  return { id, type: "Announce", actor: REMOTE, object };
}

/**
 * A Create(Note) activity from REMOTE that replies to (mentions) `inReplyTo`
 * — a post shape (Note) AND a reply, to exercise the ordering between the
 * "mention" and "timeline" branches of `#classifyClientEntry`.
 */
function mentionCreateActivity(
  id: string,
  inReplyTo: string,
  content = "hey you",
): Record<string, unknown> {
  return {
    id,
    type: "Create",
    actor: REMOTE,
    object: { type: "Note", content, attributedTo: REMOTE, inReplyTo },
  };
}

/** A GET to a `__client/*` internal route, with the internal marker set. */
function clientRequest(username: string, pathAndQuery: string): Request {
  const iris = deriveIris(BASE, username);
  return new Request(`${iris.id}${pathAndQuery}`, {
    headers: {
      [INTERNAL_HEADERS.config]: cfgHeader(username),
      [INTERNAL_HEADERS.internal]: "1",
    },
  });
}

describe("__client/timeline", () => {
  it("404s without the internal marker", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        new Request(`${iris.id}/__client/timeline`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  it("returns Create/Note rows newest-first, excluding Like rows", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(
            likeActivity("https://remote.example/activities/timeline-like"),
          ),
        ),
      );
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(
            createNoteActivity(
              "https://remote.example/activities/timeline-create",
            ),
          ),
        ),
      );

      const res = await instance.fetch(
        clientRequest(username, "/__client/timeline?limit=10"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { activity: { type: string } }[];
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.activity.type).toBe("Create");
    });
  });

  it("paginates with max_received_at + tie_seq without skipping or duplicating", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const ids = [
        "https://remote.example/activities/page-1",
        "https://remote.example/activities/page-2",
        "https://remote.example/activities/page-3",
      ];
      for (const id of ids) {
        const res = await instance.fetch(
          inboxRequest(username, JSON.stringify(createNoteActivity(id))),
        );
        expect(res.status).toBe(202);
      }

      type Page = {
        items: {
          seq: number;
          receivedAt: number;
          activity: { id: string };
        }[];
      };

      const page1Res = await instance.fetch(
        clientRequest(username, "/__client/timeline?limit=2"),
      );
      const page1 = (await page1Res.json()) as Page;
      // Newest-first: page-3, then page-2.
      expect(page1.items.map((i) => i.activity.id)).toEqual([ids[2], ids[1]]);

      const last = page1.items[1]!;
      const page2Res = await instance.fetch(
        clientRequest(
          username,
          `/__client/timeline?limit=2&max_received_at=${last.receivedAt}&tie_seq=${last.seq}`,
        ),
      );
      const page2 = (await page2Res.json()) as Page;
      expect(page2.items.map((i) => i.activity.id)).toEqual([ids[0]]);

      // Combined across both pages: exactly the 3 ids, in order, no
      // duplication and no gap even when several rows share a `received_at`
      // millisecond (the common case under a fast test clock).
      const combined = [...page1.items, ...page2.items].map(
        (i) => i.activity.id,
      );
      expect(combined).toEqual([ids[2], ids[1], ids[0]]);
    });
  });
});

describe("__client/notifications", () => {
  it("404s without the internal marker", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        new Request(`${iris.id}/__client/notifications`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  it("classifies Like as favourite, Announce as reblog, and a new follower's Follow as follow", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance, state) => {
      // A *new* follower's Follow is stored in `inbox` (alongside its
      // `followers` row) so the notifications read can surface it; a distinct
      // re-Follow (fresh activity id, same still-recorded follower) is not a
      // fresh notification and stores no second row.
      const follow = (id: string) =>
        JSON.stringify({
          id: `https://remote.example/activities/${id}`,
          type: "Follow",
          actor: REMOTE,
          object: iris.id,
        });
      const followRes = await instance.fetch(
        inboxRequest(username, follow("notif-follow")),
      );
      expect(followRes.status).toBe(202);
      const refollowRes = await instance.fetch(
        inboxRequest(username, follow("notif-refollow")),
      );
      expect(refollowRes.status).toBe(202);
      const followRows = state.storage.sql
        .exec<{
          n: number;
        }>(`SELECT COUNT(*) AS n FROM inbox WHERE json LIKE '%"Follow"%'`)
        .one().n;
      expect(followRows).toBe(1);

      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(
            likeActivity("https://remote.example/activities/notif-like"),
          ),
        ),
      );
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(
            announceActivity(
              "https://remote.example/activities/notif-announce",
              "https://social.example/notes/own-id",
            ),
          ),
        ),
      );

      const res = await instance.fetch(
        clientRequest(username, "/__client/notifications?limit=10"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { activity: { id: string; type: string } }[];
      };
      expect(body.items).toHaveLength(3);
      expect(body.items.map((i) => i.activity.type).sort()).toEqual([
        "Announce",
        "Follow",
        "Like",
      ]);
      expect(
        body.items.some(
          (i) =>
            i.activity.id === "https://remote.example/activities/notif-follow",
        ),
      ).toBe(true);
    });
  });

  it(
    "finds a match in a later internal batch when the first batch (size " +
      "max(limit*4, 40)) has zero matches — regression: the cursor-" +
      "continuation clause must apply to every batch after the first " +
      "regardless of how many matches have been found so far, or a zero-" +
      "match first batch re-issues the same query forever",
    async () => {
      const { username, stub } = freshUser();
      await runInDurableObject(stub, async (instance) => {
        // Deliver the favourite (Like) row FIRST so it gets the lowest
        // seq/received_at — i.e. it's the *oldest* row. With limit=1, BATCH
        // = max(1*4, 40) = 40, and the default order is `received_at DESC,
        // seq DESC` (newest first), so the first internal batch of 40 rows
        // is exactly the 40 timeline (Create/Note) rows below, and the
        // older Like row is only reachable via a second, cursor-continued
        // batch.
        const likeId = "https://remote.example/activities/batch-miss-like";
        const likeRes = await instance.fetch(
          inboxRequest(username, JSON.stringify(likeActivity(likeId))),
        );
        expect(likeRes.status).toBe(202);

        for (let i = 0; i < 40; i++) {
          const res = await instance.fetch(
            inboxRequest(
              username,
              JSON.stringify(
                createNoteActivity(
                  `https://remote.example/activities/batch-miss-create-${i}`,
                ),
              ),
            ),
          );
          expect(res.status).toBe(202);
        }

        const res = await instance.fetch(
          clientRequest(username, "/__client/notifications?limit=1"),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { activity: { id: string; type: string } }[];
        };
        expect(body.items).toHaveLength(1);
        expect(body.items[0]?.activity.id).toBe(likeId);
      });
    },
    20_000,
  );

  it("classifies a reply Create(Note) targeting this actor as mention, not timeline (regression: post-shape check must not shadow inReplyTo)", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const mentionId = "https://remote.example/activities/notif-mention";
      const plainTimelineId =
        "https://remote.example/activities/notif-plain-timeline";
      const mentionRes = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(
            mentionCreateActivity(mentionId, `${iris.id}/posts/own-status-1`),
          ),
        ),
      );
      expect(mentionRes.status).toBe(202);
      // A plain top-level Create/Note with no inReplyTo — must still land in
      // the timeline, not notifications (no regression on the ordinary case).
      const plainRes = await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(createNoteActivity(plainTimelineId)),
        ),
      );
      expect(plainRes.status).toBe(202);

      const notifRes = await instance.fetch(
        clientRequest(username, "/__client/notifications?limit=10"),
      );
      expect(notifRes.status).toBe(200);
      const notifBody = (await notifRes.json()) as {
        items: { activity: { id: string; type: string } }[];
      };
      const notifIds = notifBody.items.map((i) => i.activity.id);
      expect(notifIds).toContain(mentionId);
      expect(notifIds).not.toContain(plainTimelineId);

      const timelineRes = await instance.fetch(
        clientRequest(username, "/__client/timeline?limit=10"),
      );
      expect(timelineRes.status).toBe(200);
      const timelineBody = (await timelineRes.json()) as {
        items: { activity: { id: string; type: string } }[];
      };
      const timelineIds = timelineBody.items.map((i) => i.activity.id);
      expect(timelineIds).not.toContain(mentionId);
      expect(timelineIds).toContain(plainTimelineId);
    });
  });
});

describe("__client/entry", () => {
  it("404s without the internal marker", async () => {
    const { username, iris, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      const res = await instance.fetch(
        new Request(`${iris.id}/__client/entry?received_at=1`, {
          headers: { [INTERNAL_HEADERS.config]: cfgHeader(username) },
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  it("looks up a single row by received_at, 404s when there is none", async () => {
    const { username, stub } = freshUser();
    await runInDurableObject(stub, async (instance) => {
      await instance.fetch(
        inboxRequest(
          username,
          JSON.stringify(
            createNoteActivity("https://remote.example/activities/entry-1"),
          ),
        ),
      );
      const timeline = await instance.fetch(
        clientRequest(username, "/__client/timeline?limit=1"),
      );
      const { items } = (await timeline.json()) as {
        items: { seq: number; receivedAt: number; activity: { id: string } }[];
      };
      const found = items[0]!;

      const entryRes = await instance.fetch(
        clientRequest(
          username,
          `/__client/entry?received_at=${found.receivedAt}&seq_low=${found.seq % 32768}`,
        ),
      );
      expect(entryRes.status).toBe(200);
      const entry = (await entryRes.json()) as {
        activity: { id: string };
      };
      expect(entry.activity.id).toBe(
        "https://remote.example/activities/entry-1",
      );

      const missing = await instance.fetch(
        clientRequest(username, "/__client/entry?received_at=999999999"),
      );
      expect(missing.status).toBe(404);
    });
  });
});
