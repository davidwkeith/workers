import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createActivityPub,
  type ActivityPubConfig,
  type ActivityPubEnv,
} from "./index.js";
import { INTERNAL_HEADERS, type ForwardedConfig } from "./config.js";
import { deriveIris } from "./config.js";

/**
 * End-to-end tests over the real ActivityPub front door + per-actor Durable
 * Object: the actor document, NodeInfo, paged collections, signed inbox with
 * dedup, the owner publish endpoint, and the signed `Accept`-on-`Follow`
 * delivery path (driven inside the DO with a stubbed outbound `fetch`).
 */

const testEnv = env as unknown as ActivityPubEnv;
const ctx = {} as ExecutionContext;

const BASE = "https://social.example";
const REMOTE = "https://remote.example/users/alice";

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

let publicKeyPem: string;
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
  publicKeyPem = toPem(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
    "PUBLIC KEY",
  );
  privateKeyPem = toPem(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    "PRIVATE KEY",
  );
});

/** A config whose unique username maps to a fresh, isolated Durable Object. */
function makeConfig(
  overrides: Partial<ActivityPubConfig> = {},
): ActivityPubConfig {
  const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
  return {
    baseUrl: BASE,
    actor: { username, name: "Bob" },
    publicKeyPem,
    privateKeyPem,
    ...overrides,
  };
}

function actorUrl(config: ActivityPubConfig): string {
  return `${BASE}/users/${config.actor.username}`;
}

/** Verify-bypass that accepts every inbox POST as signed by REMOTE. */
const acceptAll: ActivityPubConfig["verifyInboxSignature"] = () => ({
  ok: true,
  keyId: `${REMOTE}#main-key`,
  actor: REMOTE,
});

describe("actor document", () => {
  it("serves the Person actor as activity+json", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(new Request(actorUrl(config)), testEnv, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("activity+json");
    // The actor's inbox is also advertised via LDN discovery so a plain Linked
    // Data Notifications sender can find it from the Link header.
    expect(res.headers.get("link")).toBe(
      `<${actorUrl(config)}/inbox>; rel="http://www.w3.org/ns/ldp#inbox"`,
    );
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.type).toBe("Person");
    expect(doc.id).toBe(actorUrl(config));
    expect(doc.inbox).toBe(`${actorUrl(config)}/inbox`);
    expect((doc.publicKey as Record<string, unknown>).publicKeyPem).toBe(
      publicKeyPem,
    );
  });

  it("federates the FEP-2c59 webfinger handle derived from the base URL", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(new Request(actorUrl(config)), testEnv, ctx);
    const doc = (await res.json()) as Record<string, unknown>;
    // Host of BASE (`social.example`) + the actor's username.
    expect(doc.webfinger).toBe(`acct:${config.actor.username}@social.example`);
  });

  it("honours an explicit acctDomain for the webfinger handle", async () => {
    const config = makeConfig({ acctDomain: "example.com" });
    const handler = createActivityPub(config);
    const res = await handler(new Request(actorUrl(config)), testEnv, ctx);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.webfinger).toBe(`acct:${config.actor.username}@example.com`);
  });

  it("rejects a write to the actor IRI", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(actorUrl(config), { method: "DELETE" }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(405);
  });

  it("advertises a shared inbox endpoint by default", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(new Request(actorUrl(config)), testEnv, ctx);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.endpoints).toEqual({ sharedInbox: `${BASE}/inbox` });
  });

  it("omits the shared inbox when disabled", async () => {
    const config = makeConfig({ sharedInbox: false });
    const handler = createActivityPub(config);
    const res = await handler(new Request(actorUrl(config)), testEnv, ctx);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.endpoints).toBeUndefined();
  });

  it("content-negotiates the JSON-LD profile variant", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(actorUrl(config), {
        headers: {
          accept:
            'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        },
      }),
      testEnv,
      ctx,
    );
    expect(res.headers.get("content-type")).toContain("application/ld+json");
    expect(res.headers.get("content-type")).toContain("activitystreams");
  });
});

describe("NodeInfo", () => {
  it("serves discovery and a 2.1 doc with live usage", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);

    const discovery = await handler(
      new Request(`${BASE}/.well-known/nodeinfo`),
      testEnv,
      ctx,
    );
    expect(discovery.status).toBe(200);
    const links = ((await discovery.json()) as { links: unknown[] }).links;
    expect(links).toHaveLength(2);

    const doc = await handler(
      new Request(`${BASE}/nodeinfo/2.1`),
      testEnv,
      ctx,
    );
    const body = (await doc.json()) as Record<string, unknown>;
    expect(body.protocols).toEqual(["activitypub"]);
    expect((body.usage as Record<string, unknown>).localPosts).toBe(0);
  });

  it("also serves the 2.0 document for consumers that request it", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${BASE}/nodeinfo/2.0`),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe("2.0");
    expect(body.protocols).toEqual(["activitypub"]);
  });
});

describe("collections", () => {
  it("an unfollowed actor has empty collections", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/followers`),
      testEnv,
      ctx,
    );
    const col = (await res.json()) as Record<string, unknown>;
    expect(col.type).toBe("OrderedCollection");
    expect(col.totalItems).toBe(0);
    expect(col.first).toBeUndefined();
  });
});

describe("inbox", () => {
  it("rejects an unsigned POST with 401", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        body: JSON.stringify({ type: "Follow" }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an oversized POST with 413 before verifying the signature", async () => {
    const config = makeConfig({
      // If the body cap didn't apply first, this would run and accept it.
      verifyInboxSignature: acceptAll,
    });
    const handler = createActivityPub(config);
    const oversized = "x".repeat(3 * 1024 * 1024); // over the 2 MB cap
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-length": String(oversized.length) },
        body: oversized,
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(413);
  });

  it("answers 503 + Retry-After when the signer key cannot be resolved", async () => {
    // A temporary failure (the signer's server was briefly unreachable, so the
    // key did not resolve) must ask the peer to redeliver, not drop with 401.
    const config = makeConfig({
      verifyInboxSignature: () => ({ ok: false, reason: "key_unresolved" }),
    });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          id: "https://remote.example/1",
          type: "Follow",
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("keeps 401 for a permanent (cryptographic) signature failure", async () => {
    const config = makeConfig({
      verifyInboxSignature: () => ({ ok: false, reason: "signature_invalid" }),
    });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          id: "https://remote.example/2",
          type: "Follow",
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("refuses an activity whose actor is not the verified signer", async () => {
    // acceptAll reports REMOTE as the signer; the activity claims a different
    // actor → impersonation, blocked by the DO.
    const config = makeConfig({ verifyInboxSignature: acceptAll });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          id: "https://evil.example/1",
          type: "Follow",
          actor: "https://evil.example/users/mallory",
          object: actorUrl(config),
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("accepts a signed Follow on the shared inbox for the single actor", async () => {
    const config = makeConfig({
      verifyInboxSignature: acceptAll,
      actor: {
        username: `bob-${crypto.randomUUID().slice(0, 8)}`,
        manuallyApprovesFollowers: true,
      },
    });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${BASE}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          "@context": "https://www.w3.org/ns/activitystreams",
          id: "https://remote.example/activities/shared-1",
          type: "Follow",
          actor: REMOTE,
          object: actorUrl(config),
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(202);

    // The shared inbox routes to the single actor's DO, so the follower lands
    // in that actor's followers collection.
    const followers = (await (
      await handler(new Request(`${actorUrl(config)}/followers`), testEnv, ctx)
    ).json()) as Record<string, unknown>;
    expect(followers.totalItems).toBe(1);
  });

  it("rejects a GET on the shared inbox with 405", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(new Request(`${BASE}/inbox`), testEnv, ctx);
    expect(res.status).toBe(405);
  });

  it("refuses a Create whose embedded object is attributed to another actor", async () => {
    const config = makeConfig({ verifyInboxSignature: acceptAll });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          id: "https://remote.example/activities/spoof",
          type: "Create",
          actor: REMOTE,
          object: {
            id: "https://remote.example/notes/1",
            type: "Note",
            attributedTo: "https://evil.example/users/mallory",
            content: "not mine",
          },
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("refuses an attributedTo spoof wrapped in arrays (object/attributedTo)", async () => {
    const config = makeConfig({ verifyInboxSignature: acceptAll });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          id: "https://remote.example/activities/spoof-array",
          type: "Create",
          actor: REMOTE,
          // Both `object` and `attributedTo` are arrays: a naive check that
          // bails on arrays would let the spoofed actor through.
          object: [
            {
              id: "https://remote.example/notes/3",
              type: "Note",
              attributedTo: [REMOTE, "https://evil.example/users/mallory"],
              content: "smuggled",
            },
          ],
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("accepts a Create whose embedded object is attributed to its actor", async () => {
    const config = makeConfig({ verifyInboxSignature: acceptAll });
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify({
          id: "https://remote.example/activities/ok",
          type: "Create",
          actor: REMOTE,
          object: {
            id: "https://remote.example/notes/2",
            type: "Note",
            attributedTo: REMOTE,
            content: "mine",
          },
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(202);
  });

  it("accepts a signed Follow, records the follower, and dedups by id", async () => {
    // manuallyApprovesFollowers avoids an outbound actor fetch in this DO.
    const config = makeConfig({
      verifyInboxSignature: acceptAll,
      actor: {
        username: `bob-${crypto.randomUUID().slice(0, 8)}`,
        manuallyApprovesFollowers: true,
      },
    });
    const handler = createActivityPub(config);
    const follow = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/1",
      type: "Follow",
      actor: REMOTE,
      object: actorUrl(config),
    };
    const post = () =>
      handler(
        new Request(`${actorUrl(config)}/inbox`, {
          method: "POST",
          headers: { "content-type": "application/activity+json" },
          body: JSON.stringify(follow),
        }),
        testEnv,
        ctx,
      );

    const first = await post();
    expect(first.status).toBe(202);
    const second = await post(); // same id → deduped, still one follower
    expect(second.status).toBe(202);

    const followers = (await (
      await handler(
        new Request(`${actorUrl(config)}/followers?page=1`),
        testEnv,
        ctx,
      )
    ).json()) as Record<string, unknown>;
    expect(followers.totalItems).toBe(1);
    expect(followers.orderedItems).toEqual([REMOTE]);
  });

  it("does not unfollow on an Undo of a non-Follow activity", async () => {
    const config = makeConfig({
      verifyInboxSignature: acceptAll,
      actor: {
        username: `bob-${crypto.randomUUID().slice(0, 8)}`,
        manuallyApprovesFollowers: true,
      },
    });
    const handler = createActivityPub(config);
    const send = (activity: Record<string, unknown>) =>
      handler(
        new Request(`${actorUrl(config)}/inbox`, {
          method: "POST",
          headers: { "content-type": "application/activity+json" },
          body: JSON.stringify(activity),
        }),
        testEnv,
        ctx,
      );
    const followers = async () =>
      (
        (await (
          await handler(
            new Request(`${actorUrl(config)}/followers`),
            testEnv,
            ctx,
          )
        ).json()) as Record<string, unknown>
      ).totalItems;

    await send({
      id: "https://remote.example/act/follow",
      type: "Follow",
      actor: REMOTE,
      object: actorUrl(config),
    });
    expect(await followers()).toBe(1);

    // An Undo of a Like, with the liked object as a bare string IRI, must not
    // be mistaken for an unfollow.
    await send({
      id: "https://remote.example/act/undo-like",
      type: "Undo",
      actor: REMOTE,
      object: "https://remote.example/likes/1",
    });
    expect(await followers()).toBe(1);

    // An Undo carrying an embedded Follow is a genuine unfollow.
    await send({
      id: "https://remote.example/act/undo-follow",
      type: "Undo",
      actor: REMOTE,
      object: { type: "Follow", actor: REMOTE, object: actorUrl(config) },
    });
    expect(await followers()).toBe(0);
  });
});

describe("publish endpoint", () => {
  it("is 404 when no publish token is configured", async () => {
    const config = makeConfig();
    const handler = createActivityPub(config);
    const res = await handler(
      new Request(`${actorUrl(config)}/outbox`, {
        method: "POST",
        body: "{}",
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("requires the bearer token and publishes a Create to the outbox", async () => {
    const config = makeConfig({ publishToken: "s3cret" });
    const handler = createActivityPub(config);

    const unauthorized = await handler(
      new Request(`${actorUrl(config)}/outbox`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: JSON.stringify({ type: "Note", content: "hi" }),
      }),
      testEnv,
      ctx,
    );
    expect(unauthorized.status).toBe(401);

    const created = await handler(
      new Request(`${actorUrl(config)}/outbox`, {
        method: "POST",
        headers: {
          authorization: "Bearer s3cret",
          "content-type": "application/activity+json",
        },
        body: JSON.stringify({ type: "Note", content: "hello world" }),
      }),
      testEnv,
      ctx,
    );
    expect(created.status).toBe(201);
    const activity = (await created.json()) as Record<string, unknown>;
    expect(activity.type).toBe("Create");
    expect((activity.object as Record<string, unknown>).content).toBe(
      "hello world",
    );

    const outbox = (await (
      await handler(
        new Request(`${actorUrl(config)}/outbox?page=1`),
        testEnv,
        ctx,
      )
    ).json()) as Record<string, unknown>;
    expect(outbox.totalItems).toBe(1);
  });

  it("rejects an oversized publish body with 413", async () => {
    const config = makeConfig({ publishToken: "s3cret" });
    const handler = createActivityPub(config);
    const oversized = "x".repeat(3 * 1024 * 1024); // over the 2 MB cap
    const res = await handler(
      new Request(`${actorUrl(config)}/outbox`, {
        method: "POST",
        headers: {
          authorization: "Bearer s3cret",
          "content-length": String(oversized.length),
        },
        body: oversized,
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Delivery path, driven inside the DO with a stubbed outbound `fetch`.
// ---------------------------------------------------------------------------

/** The forwarded-config header the front door would set, for direct DO calls. */
function forwardedHeader(
  username: string,
  overrides: Partial<ForwardedConfig> = {},
): string {
  const iris = deriveIris(BASE, username);
  const config: ForwardedConfig = {
    iris,
    actorName: username,
    manuallyApprovesFollowers: false,
    manuallyApprovesJoins: overrides.manuallyApprovesJoins ?? false,
    pageSize: 50,
    deliveryMaxAttempts: 8,
    deliveryBaseDelayMs: 60_000,
    keyId: iris.keyId,
    privateKeyPem,
  };
  return JSON.stringify(config);
}

describe("Accept-on-Follow delivery", () => {
  it("resolves the follower inbox and delivers a signed Accept", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, _state) => {
      const original = globalThis.fetch;
      const seen: { url: string; init?: RequestInit }[] = [];
      // Stub outbound fetch: serve the remote actor doc, capture the Accept POST.
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const href = typeof url === "string" ? url : url.toString();
        seen.push({ url: href, init });
        if (href === REMOTE) {
          return new Response(
            JSON.stringify({
              id: REMOTE,
              inbox: `${REMOTE}/inbox`,
              publicKey: {
                id: `${REMOTE}#main-key`,
                owner: REMOTE,
                publicKeyPem,
              },
            }),
            { headers: { "content-type": "application/activity+json" } },
          );
        }
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;

      try {
        const follow = {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: "https://remote.example/activities/42",
          type: "Follow",
          actor: REMOTE,
          object: iris.id,
        };
        const res = await instance.fetch(
          new Request(iris.inbox, {
            method: "POST",
            headers: {
              "content-type": "application/activity+json",
              [INTERNAL_HEADERS.config]: forwardedHeader(username),
            },
            body: JSON.stringify(follow),
          }),
        );
        expect(res.status).toBe(202);

        // Delivery is alarm-driven (not inline); drive the queue deterministically.
        await instance.fetch(
          new Request(`${iris.id}/__deliver`, {
            headers: { [INTERNAL_HEADERS.config]: forwardedHeader(username) },
          }),
        );

        // The remote actor was fetched, then a signed Accept POSTed to its inbox.
        const delivery = seen.find((s) => s.url === `${REMOTE}/inbox`);
        expect(delivery).toBeDefined();
        expect(delivery?.init?.method).toBe("POST");
        const headers = delivery?.init?.headers as Record<string, string>;
        expect(headers.Signature).toContain(`keyId="${iris.keyId}"`);
        expect(headers.Digest).toMatch(/^SHA-256=/);
        const raw = delivery?.init?.body as ArrayBufferView;
        const body = JSON.parse(new TextDecoder().decode(raw));
        expect(body.type).toBe("Accept");
        expect(body.object.id).toBe("https://remote.example/activities/42");
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  it("keeps a retryable (5xx) delivery queued with an incremented attempt", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, state) => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        const href = typeof url === "string" ? url : url.toString();
        if (href === REMOTE) {
          return new Response(
            JSON.stringify({
              id: REMOTE,
              inbox: `${REMOTE}/inbox`,
              publicKey: { publicKeyPem, owner: REMOTE },
            }),
            { headers: { "content-type": "application/activity+json" } },
          );
        }
        return new Response("busy", { status: 503 });
      }) as unknown as typeof fetch;

      try {
        await instance.fetch(
          new Request(iris.inbox, {
            method: "POST",
            headers: {
              "content-type": "application/activity+json",
              [INTERNAL_HEADERS.config]: forwardedHeader(username),
            },
            body: JSON.stringify({
              id: "https://remote.example/activities/99",
              type: "Follow",
              actor: REMOTE,
              object: iris.id,
            }),
          }),
        );

        // One delivery pass (alarm-driven) hits the 503 and requeues with backoff.
        await instance.fetch(
          new Request(`${iris.id}/__deliver`, {
            headers: { [INTERNAL_HEADERS.config]: forwardedHeader(username) },
          }),
        );

        const row = state.storage.sql
          .exec<{ attempts: number }>("SELECT attempts FROM delivery LIMIT 1")
          .toArray()[0];
        expect(row?.attempts).toBe(1);
      } finally {
        globalThis.fetch = original;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Event RSVPs (#171): inbound Join/Leave update participation, the AP mirror of
// an Indie RSVP. Driven inside the DO with a stubbed outbound `fetch`.
// ---------------------------------------------------------------------------

describe("Event RSVP (Join/Leave)", () => {
  it("records an accepted participant and delivers a signed Accept for a Join to a local event", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const event = `${iris.id}/events/picnic`;
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, state) => {
      const original = globalThis.fetch;
      const seen: { url: string; init?: RequestInit }[] = [];
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const href = typeof url === "string" ? url : url.toString();
        seen.push({ url: href, init });
        if (href === REMOTE) {
          return new Response(
            JSON.stringify({
              id: REMOTE,
              inbox: `${REMOTE}/inbox`,
              publicKey: {
                id: `${REMOTE}#main-key`,
                owner: REMOTE,
                publicKeyPem,
              },
            }),
            { headers: { "content-type": "application/activity+json" } },
          );
        }
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;

      try {
        const res = await instance.fetch(
          new Request(iris.inbox, {
            method: "POST",
            headers: {
              "content-type": "application/activity+json",
              [INTERNAL_HEADERS.config]: forwardedHeader(username),
            },
            body: JSON.stringify({
              id: "https://remote.example/activities/join-1",
              type: "Join",
              actor: REMOTE,
              object: event,
            }),
          }),
        );
        expect(res.status).toBe(202);

        const row = state.storage.sql
          .exec<{
            status: string;
          }>(
            "SELECT status FROM attendees WHERE event = ? AND actor = ?",
            event,
            REMOTE,
          )
          .toArray()[0];
        expect(row?.status).toBe("accepted");

        await instance.fetch(
          new Request(`${iris.id}/__deliver`, {
            headers: { [INTERNAL_HEADERS.config]: forwardedHeader(username) },
          }),
        );

        const delivery = seen.find((s) => s.url === `${REMOTE}/inbox`);
        expect(delivery?.init?.method).toBe("POST");
        const raw = delivery?.init?.body as ArrayBufferView;
        const body = JSON.parse(new TextDecoder().decode(raw));
        expect(body.type).toBe("Accept");
        expect(body.object.type).toBe("Join");
        expect(body.object.id).toBe("https://remote.example/activities/join-1");
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  it("is idempotent for a re-Join: keeps accepted and does not re-deliver", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const event = `${iris.id}/events/picnic`;
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, state) => {
      const original = globalThis.fetch;
      let inboxLookups = 0;
      globalThis.fetch = (async (url: string | URL) => {
        const href = typeof url === "string" ? url : url.toString();
        if (href === REMOTE) {
          inboxLookups += 1;
          return new Response(
            JSON.stringify({
              id: REMOTE,
              inbox: `${REMOTE}/inbox`,
              publicKey: {
                id: `${REMOTE}#main-key`,
                owner: REMOTE,
                publicKeyPem,
              },
            }),
            { headers: { "content-type": "application/activity+json" } },
          );
        }
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;

      const join = (id: string) =>
        instance.fetch(
          new Request(iris.inbox, {
            method: "POST",
            headers: {
              "content-type": "application/activity+json",
              [INTERNAL_HEADERS.config]: forwardedHeader(username),
            },
            body: JSON.stringify({
              id,
              type: "Join",
              actor: REMOTE,
              object: event,
            }),
          }),
        );

      try {
        // First Join: accepted, one Accept enqueued, one inbox lookup.
        await join("https://remote.example/activities/join-a");
        // Inbox resolution is alarm-driven (not inline); resolve without also
        // running a delivery attempt, so the queued-but-undelivered count below
        // still reflects a single Accept.
        await instance.fetch(
          new Request(`${iris.id}/__resolve`, {
            headers: { [INTERNAL_HEADERS.config]: forwardedHeader(username) },
          }),
        );
        // A distinct Join activity (new id, bypasses activity-id dedup) for the
        // same already-accepted participant must be a no-op.
        await join("https://remote.example/activities/join-b");
        await instance.fetch(
          new Request(`${iris.id}/__resolve`, {
            headers: { [INTERNAL_HEADERS.config]: forwardedHeader(username) },
          }),
        );

        const row = state.storage.sql
          .exec<{
            status: string;
          }>(
            "SELECT status FROM attendees WHERE event = ? AND actor = ?",
            event,
            REMOTE,
          )
          .toArray()[0];
        expect(row?.status).toBe("accepted");

        // No second Accept enqueued and no second inbox resolution on the replay.
        const queued = state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM delivery")
          .one().n;
        expect(queued).toBe(1);
        expect(inboxLookups).toBe(1);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  it("holds a Join pending and delivers nothing when joins are manually approved", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const event = `${iris.id}/events/gala`;
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, state) => {
      const original = globalThis.fetch;
      // Manual approval must not trigger any outbound network (inbox lookup).
      globalThis.fetch = (async () => {
        throw new Error(
          "no outbound fetch expected for a manually-approved Join",
        );
      }) as unknown as typeof fetch;

      try {
        await instance.fetch(
          new Request(iris.inbox, {
            method: "POST",
            headers: {
              "content-type": "application/activity+json",
              [INTERNAL_HEADERS.config]: forwardedHeader(username, {
                manuallyApprovesJoins: true,
              }),
            },
            body: JSON.stringify({
              id: "https://remote.example/activities/join-2",
              type: "Join",
              actor: REMOTE,
              object: event,
            }),
          }),
        );

        const row = state.storage.sql
          .exec<{
            status: string;
          }>(
            "SELECT status FROM attendees WHERE event = ? AND actor = ?",
            event,
            REMOTE,
          )
          .toArray()[0];
        expect(row?.status).toBe("pending");

        const queued = state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM delivery")
          .one().n;
        expect(queued).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  it("removes the participant on a Leave", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const event = `${iris.id}/events/standup`;
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, state) => {
      const send = (activity: Record<string, unknown>) =>
        instance.fetch(
          new Request(iris.inbox, {
            method: "POST",
            headers: {
              "content-type": "application/activity+json",
              [INTERNAL_HEADERS.config]: forwardedHeader(username, {
                manuallyApprovesJoins: true,
              }),
            },
            body: JSON.stringify(activity),
          }),
        );
      const count = () =>
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM attendees")
          .one().n;

      await send({
        id: "https://remote.example/activities/join-3",
        type: "Join",
        actor: REMOTE,
        object: event,
      });
      expect(count()).toBe(1);

      await send({
        id: "https://remote.example/activities/leave-3",
        type: "Leave",
        actor: REMOTE,
        object: event,
      });
      expect(count()).toBe(0);
    });
  });

  it("ignores a Join targeting an event we do not own", async () => {
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const iris = deriveIris(BASE, username);
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(iris.id));

    await runInDurableObject(stub, async (instance, state) => {
      await instance.fetch(
        new Request(iris.inbox, {
          method: "POST",
          headers: {
            "content-type": "application/activity+json",
            [INTERNAL_HEADERS.config]: forwardedHeader(username, {
              manuallyApprovesJoins: true,
            }),
          },
          body: JSON.stringify({
            id: "https://remote.example/activities/join-4",
            type: "Join",
            actor: REMOTE,
            object: "https://other.example/events/not-ours",
          }),
        }),
      );

      const count = state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM attendees")
        .one().n;
      expect(count).toBe(0);
    });
  });
});
