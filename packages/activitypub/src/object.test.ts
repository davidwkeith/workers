import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  INTERNAL_HEADERS,
  deriveIris,
  type ActivityPubEnv,
  type ForwardedConfig,
} from "./config.js";

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
    manuallyApprovesFollowers: false,
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
      const deliveries = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      return { status: res.status, deliveries };
    }),
  );
}

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
): Request {
  const iris = deriveIris(BASE, username);
  const headers: Record<string, string> = {
    "content-type": "application/activity+json",
    [INTERNAL_HEADERS.config]: cfgHeader(username),
  };
  if (publish) headers[INTERNAL_HEADERS.publish] = "1";
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
