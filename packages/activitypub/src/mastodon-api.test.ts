import { env, runInDurableObject } from "cloudflare:test";
import type { MastodonApiEnv } from "@dwk/mastodon-api";
import { decodeSnowflake, encodeSnowflake } from "@dwk/mastodon-api";
import { beforeEach, describe, expect, it } from "vitest";

import {
  INTERNAL_HEADERS,
  resolveConfig,
  type ActivityPubEnv,
  type ResolvedConfig,
} from "./config.js";
import { forwardedConfig } from "./handler.js";
import {
  buildMastodonBackend,
  createActivitypubMastodonApi,
} from "./mastodon-api.js";

const testEnv = env as unknown as ActivityPubEnv & MastodonApiEnv;
const testCtx = {} as ExecutionContext;

/** A fresh actor config, isolated per test via a random username (⇒ a fresh DO). */
function freshConfig(): ResolvedConfig {
  return resolveConfig({
    baseUrl: "https://owner.example",
    actor: { username: `owner-${crypto.randomUUID().slice(0, 8)}` },
    publicKeyPem: "PUBLIC-PEM",
  });
}

/** Deliver an activity straight into the actor's inbox via the DO's own `fetch`, bypassing HTTP signature verification (only the front door checks it). */
async function seedActivity(
  config: ResolvedConfig,
  activity: Record<string, unknown>,
): Promise<void> {
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  const response = await stub.fetch(
    new Request(config.iris.inbox, {
      method: "POST",
      headers: {
        "content-type": "application/activity+json",
        [INTERNAL_HEADERS.config]: JSON.stringify(forwardedConfig(config)),
      },
      body: JSON.stringify(activity),
    }),
  );
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(
      `seedActivity: unexpected ${response.status} ${await response.text()}`,
    );
  }
}

let counter = 0;
/** A Create/Note timeline-shaped activity (no `inReplyTo`). */
function createNote(config: ResolvedConfig): Record<string, unknown> {
  counter += 1;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${config.iris.id}/activities/note-${counter}`,
    type: "Create",
    actor: "https://remote.example/users/bob",
    object: {
      id: `https://remote.example/objects/note-${counter}`,
      type: "Note",
      content: `hello ${counter}`,
    },
  };
}

/** A Create/Note mention (`inReplyTo` addresses this actor) — a notification, not a timeline row. */
function createMention(config: ResolvedConfig): Record<string, unknown> {
  counter += 1;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${config.iris.id}/activities/mention-${counter}`,
    type: "Create",
    actor: "https://remote.example/users/carol",
    object: {
      id: `https://remote.example/objects/mention-${counter}`,
      type: "Note",
      content: `hi @owner ${counter}`,
      inReplyTo: `${config.iris.id}/posts/${counter}`,
    },
  };
}

/** A Like — a favourite notification. */
function likeActivity(config: ResolvedConfig): Record<string, unknown> {
  counter += 1;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${config.iris.id}/activities/like-${counter}`,
    type: "Like",
    actor: "https://remote.example/users/dana",
    object: `${config.iris.id}/outbox/${counter}`,
  };
}

/** Directly seed the `outbox`/`followers` tables `__stats` counts, bypassing the publish/follow flows (out of scope here). */
async function seedStatsRows(
  config: ResolvedConfig,
  counts: { posts: number; followers: number },
): Promise<void> {
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  await runInDurableObject(stub, async (_instance, state) => {
    for (let i = 0; i < counts.posts; i++) {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${config.iris.id}/outbox/post-${i}`,
        "{}",
        Date.now(),
      );
    }
    for (let i = 0; i < counts.followers; i++) {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        `https://remote.example/users/follower-${i}`,
        `https://remote.example/users/follower-${i}/inbox`,
        Date.now(),
      );
    }
  });
}

interface AppResponse {
  readonly client_id: string;
  readonly client_secret: string;
}

/**
 * Inline the app-registration → authorize → token exchange
 * (`packages/mastodon-api/src/test-harness.ts`'s `registerApp`/
 * `obtainAccessToken`, ~15 lines) pointed at our composed `handler` — the
 * mastodon-api test-harness itself is excluded from the published build, so
 * it can't be imported cross-package.
 */
async function obtainAccessToken(
  handler: (
    request: Request,
    env: ActivityPubEnv & MastodonApiEnv,
    ctx: ExecutionContext,
  ) => Promise<Response>,
): Promise<string> {
  const appRes = await handler(
    new Request("https://owner.example/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Tusky",
        redirect_uris: "app://oauth-callback",
        scopes: "read write follow push",
      }),
    }),
    testEnv,
    testCtx,
  );
  if (appRes.status !== 200) {
    throw new Error(`registerApp: unexpected ${appRes.status}`);
  }
  const app = (await appRes.json()) as AppResponse;

  const authorize = new URL("https://owner.example/oauth/authorize");
  authorize.searchParams.set("client_id", app.client_id);
  authorize.searchParams.set("redirect_uri", "app://oauth-callback");
  authorize.searchParams.set("response_type", "code");
  const redirect = await handler(
    new Request(authorize.toString()),
    testEnv,
    testCtx,
  );
  const code = new URL(redirect.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error("obtainAccessToken: authorize minted no code");

  const tokenRes = await handler(
    new Request("https://owner.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://oauth-callback",
        code,
      }),
    }),
    testEnv,
    testCtx,
  );
  if (tokenRes.status !== 200) {
    throw new Error(`obtainAccessToken: unexpected ${tokenRes.status}`);
  }
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

async function resetAuthDb(): Promise<void> {
  for (const table of [
    "mastodon_apps",
    "mastodon_codes",
    "mastodon_tokens",
    "mastodon_markers",
  ]) {
    await testEnv.AUTH_DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

describe("createActivitypubMastodonApi", () => {
  beforeEach(resetAuthDb);

  it("wires the composed handler so account() reflects live __stats through verify_credentials", async () => {
    const config = freshConfig();
    await seedStatsRows(config, { posts: 5, followers: 2 });

    const handler = createActivitypubMastodonApi({
      config,
      actor: testEnv.ACTOR,
      mastodonConfig: {
        baseUrl: config.baseUrl,
        instance: { title: "t" },
        account: { username: config.actor.username },
        approveAuthorization: async () => ({ approved: true }),
      },
    });

    const token = await obtainAccessToken(handler);
    const res = await handler(
      new Request("https://owner.example/api/v1/accounts/verify_credentials", {
        headers: { authorization: `Bearer ${token}` },
      }),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(200);
    const account = (await res.json()) as Record<string, unknown>;
    expect(account["followers_count"]).toBe(2);
    expect(account["statuses_count"]).toBe(5);
  });

  it("404s an unrouted path through the composed handler (still @dwk/mastodon-api's router)", async () => {
    const config = freshConfig();
    const handler = createActivitypubMastodonApi({
      config,
      actor: testEnv.ACTOR,
      mastodonConfig: {
        baseUrl: config.baseUrl,
        instance: { title: "t" },
        account: { username: config.actor.username },
        approveAuthorization: async () => ({ approved: true }),
      },
    });
    const res = await handler(
      new Request("https://owner.example/api/v1/does-not-exist"),
      testEnv,
      testCtx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Record not found" });
  });
});

describe("buildMastodonBackend", () => {
  it("account() reads live counts from __stats", async () => {
    const config = freshConfig();
    await seedStatsRows(config, { posts: 3, followers: 1 });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const account = await backend.account();
    expect(account.counts).toEqual({
      followers: 1,
      following: 0,
      statuses: 3,
    });
  });

  it("timeline() lists Create/Note rows newest-first as snowflake-id BackendEntry rows", async () => {
    const config = freshConfig();
    const first = createNote(config);
    const second = createNote(config);
    await seedActivity(config, first);
    await seedActivity(config, second);
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.timeline({ limit: 10 });
    expect(page.entries.map((e) => e.activity["id"])).toEqual([
      second["id"],
      first["id"],
    ]);
    expect(page.entries[0]?.objectType).toBe("Note");
    expect(page.entries[0]?.relayedBy).toBeNull();
    // ids round-trip through the snowflake codec (receivedAtMs is a safe integer).
    const decoded = decodeSnowflake(page.entries[0]!.id);
    expect(decoded).not.toBeNull();
    expect(decoded!.receivedAtMs).toBe(page.entries[0]!.receivedAt);
  });

  it("timeline() merges the owner's outbox posts with source-bit-1 ids", async () => {
    const config = freshConfig();
    await seedActivity(config, createNote(config));
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${config.iris.outbox}/local-1`,
        JSON.stringify({
          id: `${config.iris.outbox}/local-1`,
          type: "Create",
          actor: config.iris.id,
          object: {
            id: `${config.iris.outbox}/local-1/object`,
            type: "Note",
            content: "local post",
          },
        }),
        Date.now() + 1,
      );
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.timeline({ limit: 10 });
    const local = page.entries.find(
      (entry) => entry.activity["id"] === `${config.iris.outbox}/local-1`,
    );
    expect(local?.source).toBe(1);
    expect(decodeSnowflake(local!.id)?.source).toBe(1);
  });

  it("ownStatuses() lists only the owner's outbox posts, excluding inbox rows", async () => {
    const config = freshConfig();
    await seedActivity(config, createNote(config));
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    const publishedAt = Date.now() + 1;
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [suffix, offset] of [
        ["own-1", 0],
        ["own-2", 1],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
          `${config.iris.outbox}/${suffix}`,
          JSON.stringify({
            id: `${config.iris.outbox}/${suffix}`,
            type: "Create",
            actor: config.iris.id,
            object: {
              id: `${config.iris.outbox}/${suffix}/object`,
              type: "Note",
              content: suffix,
            },
          }),
          publishedAt + offset,
        );
      }
      // A non-post outbox activity (a Like) must not surface as a status.
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${config.iris.outbox}/own-like`,
        JSON.stringify({
          id: `${config.iris.outbox}/own-like`,
          type: "Like",
          actor: config.iris.id,
          object: "https://remote.example/notes/1",
        }),
        publishedAt + 2,
      );
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    expect(backend.ownStatuses).toBeDefined();
    const page = await backend.ownStatuses!({ limit: 10 });
    expect(page.entries.map((entry) => entry.activity["id"])).toEqual([
      `${config.iris.outbox}/own-2`,
      `${config.iris.outbox}/own-1`,
    ]);
    for (const entry of page.entries) {
      expect(entry.source).toBe(1);
      expect(decodeSnowflake(entry.id)?.source).toBe(1);
    }

    const next = await backend.ownStatuses!({
      limit: 10,
      maxId: page.entries[0]!.id,
    });
    expect(next.entries.map((entry) => entry.activity["id"])).toEqual([
      `${config.iris.outbox}/own-1`,
    ]);
  });

  it("pages from an owner-post cursor to same-millisecond inbox entries", async () => {
    const config = freshConfig();
    const timestamp = Date.now();
    const inboxActivity = {
      id: `${config.iris.id}/activities/same-millisecond-inbox`,
      type: "Create",
      actor: "https://remote.example/users/bob",
      object: {
        id: "https://remote.example/objects/same-millisecond-inbox",
        type: "Note",
        content: "inbox post",
      },
    };
    const outboxActivity = {
      id: `${config.iris.outbox}/same-millisecond-outbox`,
      type: "Create",
      actor: config.iris.id,
      object: {
        id: `${config.iris.outbox}/same-millisecond-outbox/object`,
        type: "Note",
        content: "owner post",
      },
    };
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO inbox (id, json, received_at, object_type)
           VALUES (?, ?, ?, 'Note')`,
        inboxActivity.id,
        JSON.stringify(inboxActivity),
        timestamp,
      );
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        outboxActivity.id,
        JSON.stringify(outboxActivity),
        timestamp,
      );
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const first = await backend.timeline({ limit: 1 });
    expect(first.entries[0]?.source).toBe(1);

    const next = await backend.timeline({
      limit: 10,
      maxId: first.entries[0]!.id,
    });
    expect(next.entries.map((entry) => entry.activity["id"])).toEqual([
      inboxActivity.id,
    ]);
  });

  it("fills an outbox page past non-post activities", async () => {
    const config = freshConfig();
    const timestamp = Date.now();
    const ownerPost = {
      id: `${config.iris.outbox}/older-owner-post`,
      type: "Create",
      actor: config.iris.id,
      object: {
        id: `${config.iris.outbox}/older-owner-post/object`,
        type: "Note",
        content: "owner post",
      },
    };
    const ownerLike = {
      id: `${config.iris.outbox}/newer-owner-like`,
      type: "Like",
      actor: config.iris.id,
      object: "https://remote.example/objects/1",
    };
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        ownerPost.id,
        JSON.stringify(ownerPost),
        timestamp,
      );
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        ownerLike.id,
        JSON.stringify(ownerLike),
        timestamp + 1,
      );
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.timeline({ limit: 1 });
    expect(page.entries.map((entry) => entry.activity["id"])).toEqual([
      ownerPost.id,
    ]);
  });

  it("caps the outbox scan instead of exhausting a like-dominated table", async () => {
    const config = freshConfig();
    const timestamp = Date.now();
    // limit:1 => BATCH = max(1*4, 40) = 40; MAX_OUTBOX_SCAN_BATCHES = 25, so
    // the scan gives up after 1000 rows. Bury a real owner post behind 1000
    // newer non-post rows so it falls just past that cap.
    const buriedPost = {
      id: `${config.iris.outbox}/buried-owner-post`,
      type: "Create",
      actor: config.iris.id,
      object: {
        id: `${config.iris.outbox}/buried-owner-post/object`,
        type: "Note",
        content: "buried owner post",
      },
    };
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        buriedPost.id,
        JSON.stringify(buriedPost),
        timestamp,
      );
      for (let i = 0; i < 1000; i++) {
        const like = {
          id: `${config.iris.outbox}/scan-cap-like-${i}`,
          type: "Like",
          actor: config.iris.id,
          object: `https://remote.example/objects/${i}`,
        };
        state.storage.sql.exec(
          `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
          like.id,
          JSON.stringify(like),
          timestamp + i + 1,
        );
      }
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.timeline({ limit: 1 });
    expect(
      page.entries.some((entry) => entry.activity["id"] === buriedPost.id),
    ).toBe(false);
  });

  it("serves cached actor profile fields without an outbound request", async () => {
    const config = freshConfig();
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO actor_cache (actor, json, fetched_at) VALUES (?, ?, ?)`,
        "https://remote.example/users/bob",
        JSON.stringify({
          preferredUsername: "bob",
          name: "Bob Example",
          summary: "<p>bio</p>",
          icon: { url: "https://remote.example/avatar.png" },
        }),
        Date.now(),
      );
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    expect(
      await backend.actorProfile?.("https://remote.example/users/bob"),
    ).toMatchObject({
      name: "Bob Example",
      icon: "https://remote.example/avatar.png",
    });
  });

  it("timeline() excludes mentions/favourites/reblogs (notification-shaped rows)", async () => {
    const config = freshConfig();
    await seedActivity(config, createNote(config));
    await seedActivity(config, createMention(config));
    await seedActivity(config, likeActivity(config));
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.timeline({ limit: 10 });
    expect(page.entries).toHaveLength(1);
  });

  it("derives reply, favourite, and reblog counts from stored inbox activity", async () => {
    const config = freshConfig();
    const post = createNote(config);
    const target = (post["object"] as { id: string }).id;
    await seedActivity(config, post);
    await seedActivity(config, {
      id: `${config.iris.id}/activities/like-count`,
      type: "Like",
      actor: "https://remote.example/users/like",
      object: target,
    });
    await seedActivity(config, {
      id: `${config.iris.id}/activities/reblog-count`,
      type: "Announce",
      actor: "https://remote.example/users/reblog",
      object: target,
    });
    await seedActivity(config, {
      id: `${config.iris.id}/activities/reply-count`,
      type: "Create",
      actor: "https://remote.example/users/reply",
      object: {
        id: `${config.iris.id}/objects/reply-count`,
        type: "Note",
        inReplyTo: target,
      },
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    const entry = (await backend.timeline({ limit: 10 })).entries.find(
      (candidate) => candidate.activity["id"] === post["id"],
    );
    expect(entry?.interactions).toEqual({
      replies: 1,
      favourites: 1,
      reblogs: 1,
    });
  });

  it("notifications() surfaces mentions and favourites, not plain timeline posts", async () => {
    const config = freshConfig();
    await seedActivity(config, createNote(config));
    const mention = createMention(config);
    await seedActivity(config, mention);
    const like = likeActivity(config);
    await seedActivity(config, like);
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.notifications({ limit: 10 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((e) => e.activity["id"]).sort()).toEqual(
      [mention["id"], like["id"]].sort(),
    );
  });

  it("notifications() surfaces a new follower's Follow once — a re-Follow is not a fresh notification", async () => {
    // manuallyApprovesFollowers avoids an outbound actor fetch in this DO.
    const config = resolveConfig({
      baseUrl: "https://owner.example",
      actor: {
        username: `owner-${crypto.randomUUID().slice(0, 8)}`,
        manuallyApprovesFollowers: true,
      },
      publicKeyPem: "PUBLIC-PEM",
    });
    const follow = (id: string) => ({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `https://remote.example/activities/${id}`,
      type: "Follow",
      actor: "https://remote.example/users/frank",
      object: config.iris.id,
    });
    await seedActivity(config, follow("follow-1"));
    // A distinct re-Follow (fresh id, so not caught by activity dedup) from
    // the same, still-recorded follower is not a new notification.
    await seedActivity(config, follow("follow-2"));
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.notifications({ limit: 10 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.activity["type"]).toBe("Follow");

    // After an unfollow, following again is a genuinely new follower — and a
    // fresh notification alongside the historical one.
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/unfollow-1",
      type: "Undo",
      actor: "https://remote.example/users/frank",
      object: follow("follow-1"),
    });
    await seedActivity(config, follow("follow-3"));
    const after = await backend.notifications({ limit: 10 });
    expect(after.entries).toHaveLength(2);
  });

  it("notifications() excludes a misaddressed Follow (never recorded)", async () => {
    const config = resolveConfig({
      baseUrl: "https://owner.example",
      actor: {
        username: `owner-${crypto.randomUUID().slice(0, 8)}`,
        manuallyApprovesFollowers: true,
      },
      publicKeyPem: "PUBLIC-PEM",
    });
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/misaddressed",
      type: "Follow",
      actor: "https://remote.example/users/frank",
      object: "https://someone-else.example/users/other",
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    const page = await backend.notifications({ limit: 10 });
    expect(page.entries).toHaveLength(0);
  });

  it("caps the inbox scan instead of exhausting a plain-post-dominated table", async () => {
    const config = freshConfig();
    const timestamp = Date.now();
    // limit:1 => BATCH = max(1*4, 40) = 40; MAX_SCAN_BATCHES = 25, so the
    // scan gives up after 1000 rows. Bury a real mention behind 1000 newer
    // plain (non-notification) rows so it falls just past that cap.
    const buriedMention = createMention(config);
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO inbox (id, json, received_at, object_type)
           VALUES (?, ?, ?, 'Note')`,
        buriedMention["id"] as string,
        JSON.stringify(buriedMention),
        timestamp,
      );
      for (let i = 0; i < 1000; i++) {
        const note = createNote(config);
        state.storage.sql.exec(
          `INSERT INTO inbox (id, json, received_at, object_type)
             VALUES (?, ?, ?, 'Note')`,
          note["id"] as string,
          JSON.stringify(note),
          timestamp + i + 1,
        );
      }
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.notifications({ limit: 1 });
    expect(
      page.entries.some(
        (entry) => entry.activity["id"] === buriedMention["id"],
      ),
    ).toBe(false);
  });

  it("timeline() maxId cursor translates to max_received_at/tie_seq and excludes newer rows", async () => {
    const config = freshConfig();
    const first = createNote(config);
    const second = createNote(config);
    const third = createNote(config);
    await seedActivity(config, first);
    await seedActivity(config, second);
    await seedActivity(config, third);
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const fullPage = await backend.timeline({ limit: 10 });
    expect(fullPage.entries.map((e) => e.activity["id"])).toEqual([
      third["id"],
      second["id"],
      first["id"],
    ]);
    const newestId = fullPage.entries[0]!.id;

    const olderPage = await backend.timeline({ limit: 10, maxId: newestId });
    expect(olderPage.entries.map((e) => e.activity["id"])).toEqual([
      second["id"],
      first["id"],
    ]);
  });

  it("timeline() minId cursor still returns entries newest-first (DO returns oldest-first for min_id-style queries; the adapter must normalize)", async () => {
    const config = freshConfig();
    const first = createNote(config);
    const second = createNote(config);
    const third = createNote(config);
    await seedActivity(config, first);
    await seedActivity(config, second);
    await seedActivity(config, third);
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const fullPage = await backend.timeline({ limit: 10 });
    expect(fullPage.entries.map((e) => e.activity["id"])).toEqual([
      third["id"],
      second["id"],
      first["id"],
    ]);
    const oldestId = fullPage.entries[fullPage.entries.length - 1]!.id;

    // A minId query walks forward from the oldest row: the DO's own
    // #listClientEntries deliberately returns matches ASC (oldest-first) in
    // this case, so the adapter must reverse before handing back
    // BackendPage.entries, whose contract is "always newest-first"
    // regardless of which cursor selected the page.
    const newerPage = await backend.timeline({ limit: 10, minId: oldestId });
    expect(newerPage.entries.map((e) => e.activity["id"])).toEqual([
      third["id"],
      second["id"],
    ]);
  });

  it("timeline() minId selects the nearest unseen owner post before normalizing its order", async () => {
    const config = freshConfig();
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    const publishedAt = Date.now();
    await runInDurableObject(stub, async (_instance, state) => {
      for (const offset of [0, 1, 2]) {
        state.storage.sql.exec(
          `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
          `${config.iris.outbox}/local-min-${offset}`,
          JSON.stringify({
            id: `${config.iris.outbox}/local-min-${offset}`,
            type: "Create",
            actor: config.iris.id,
            object: {
              id: `${config.iris.outbox}/local-min-${offset}/object`,
              type: "Note",
              content: `local ${offset}`,
            },
          }),
          publishedAt + offset,
        );
      }
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    const all = await backend.timeline({ limit: 10 });
    const oldest = all.entries[all.entries.length - 1]!;

    const next = await backend.timeline({ limit: 1, minId: oldest.id });
    expect(next.entries.map((entry) => entry.activity["id"])).toEqual([
      `${config.iris.outbox}/local-min-1`,
    ]);
  });

  it("timeline() with an undecodable minId does NOT reverse the page (min_received_at never reached the DO request, so the DO's own default newest-first order must pass through unchanged)", async () => {
    const config = freshConfig();
    const first = createNote(config);
    const second = createNote(config);
    await seedActivity(config, first);
    await seedActivity(config, second);
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    // "not-a-number" fails decodeSnowflake's `/^\d+$/` check, so
    // cursorParams's bound() helper silently no-ops and never sets
    // min_received_at on the outgoing DO request. The DO therefore takes its
    // default (non-minId) branch and returns rows already newest-first; the
    // adapter must NOT reverse this page. Keying the reversal off the raw
    // `query.minId !== undefined` presence (the bug this test guards
    // against) would incorrectly flip it to oldest-first.
    const page = await backend.timeline({ limit: 10, minId: "not-a-number" });
    expect(page.entries.map((e) => e.activity["id"])).toEqual([
      second["id"],
      first["id"],
    ]);
  });

  it("entry() decodes a snowflake id and fetches the exact row by received_at + seq_low", async () => {
    const config = freshConfig();
    await seedActivity(config, createNote(config));
    const target = createNote(config);
    await seedActivity(config, target);
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });

    const page = await backend.timeline({ limit: 10 });
    const wanted = page.entries.find((e) => e.activity["id"] === target["id"]);
    expect(wanted).toBeDefined();

    const fetched = await backend.entry(wanted!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.activity["id"]).toBe(target["id"]);
    expect(fetched!.receivedAt).toBe(wanted!.receivedAt);
  });

  it("publishStatus() escapes HTML metacharacters in both content and the CW summary", async () => {
    const config = freshConfig();
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO followers (actor, inbox, added_at) VALUES (?, ?, ?)`,
        "https://remote.example/users/bob",
        "https://remote.example/users/bob/inbox",
        1,
      );
    });
    const entry = await backend.publishStatus!({
      status: "a <b> & c",
      spoilerText: "cw <x> & y",
      sensitive: true,
    });
    const object = (entry.activity as { object: Record<string, unknown> })
      .object;
    // The federated Note carries escaped HTML in content and summary alike, so
    // a `<`/`&` never becomes literal markup on a receiving instance.
    expect(object.content).toBe("<p>a &lt;b&gt; &amp; c</p>");
    expect(object.summary).toBe("cw &lt;x&gt; &amp; y");
    expect(entry.source).toBe(1);
    // #clientPublish never sets skipDelivery, so live posting still fans out
    // to existing followers (guards against a future default-parameter slip).
    await runInDurableObject(stub, async (_instance, state) => {
      const queued = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM delivery`)
        .one().n;
      expect(queued).toBe(1);
    });
  });

  it("resolves inReplyTo to the owner's outbox post (in_reply_to snowflake + owner author)", async () => {
    const config = freshConfig();
    const ownerPost = `${config.iris.outbox}/reply-target/object`;
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${config.iris.outbox}/reply-target`,
        JSON.stringify({
          id: `${config.iris.outbox}/reply-target`,
          type: "Create",
          actor: config.iris.id,
          object: { id: ownerPost, type: "Note", content: "owner post" },
        }),
        Date.now(),
      );
    });
    // A remote reply addressing that owner post lands as a notification-shaped
    // inbox Create (inReplyTo targets our actor's post).
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/reply-to-owner",
      type: "Create",
      actor: "https://remote.example/users/carol",
      object: {
        id: "https://remote.example/objects/reply-to-owner",
        type: "Note",
        content: "nice post",
        inReplyTo: ownerPost,
      },
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    const page = await backend.notifications({ limit: 10 });
    const reply = page.entries.find(
      (e) =>
        e.activity["id"] === "https://remote.example/activities/reply-to-owner",
    );
    expect(reply?.inReplyTo).toBeDefined();
    expect(reply?.inReplyTo?.authorIsOwner).toBe(true);
    expect(reply?.inReplyTo?.authorIri).toBe(config.iris.id);
    expect(decodeSnowflake(reply!.inReplyTo!.id)?.source).toBe(1);
  });

  it("leaves inReplyTo undefined when the reply target is not held locally", async () => {
    const config = freshConfig();
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/orphan-reply",
      type: "Create",
      actor: "https://remote.example/users/carol",
      object: {
        id: "https://remote.example/objects/orphan-reply",
        type: "Note",
        content: "reply to nobody we have",
        inReplyTo: "https://elsewhere.example/notes/999",
      },
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    // This reply targets our actor only nominally; it won't classify as a
    // notification (inReplyTo isn't our actor id prefix), so read it via the
    // timeline is also wrong (it's a reply). Fetch it directly by id.
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    let receivedAt = 0;
    let seq = 0;
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec<{ received_at: number; seq: number }>(
          `SELECT received_at, seq FROM inbox WHERE id = ?`,
          "https://remote.example/activities/orphan-reply",
        )
        .toArray()[0]!;
      receivedAt = row.received_at;
      seq = row.seq;
    });
    const fetched = await backend.entry(encodeSnowflake(receivedAt, seq, 0));
    expect(fetched).not.toBeNull();
    expect(fetched?.inReplyTo).toBeUndefined();
  });

  it("hydrates a bare-IRI Announce of the owner's post via boost", async () => {
    const config = freshConfig();
    const ownerPost = `${config.iris.outbox}/boosted/object`;
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox (id, json, published_at) VALUES (?, ?, ?)`,
        `${config.iris.outbox}/boosted`,
        JSON.stringify({
          id: `${config.iris.outbox}/boosted`,
          type: "Create",
          actor: config.iris.id,
          object: { id: ownerPost, type: "Note", content: "boost me" },
        }),
        Date.now(),
      );
    });
    // A remote bare-IRI boost of the owner's post arrives on the timeline.
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/boost-owner",
      type: "Announce",
      actor: "https://remote.example/users/booster",
      object: ownerPost,
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    // An inbound Announce classifies as a `reblog` notification, so read the
    // entry (carrying the hydrated `boost`) from the notifications page.
    const page = await backend.notifications({ limit: 10 });
    const boost = page.entries.find(
      (e) =>
        e.activity["id"] === "https://remote.example/activities/boost-owner",
    );
    expect(boost?.boost).toBeDefined();
    expect(boost?.boost?.authorIsOwner).toBe(true);
    expect(
      (boost?.boost?.object as { content?: string } | undefined)?.content,
    ).toBe("boost me");
    expect(decodeSnowflake(boost!.boost!.id)?.source).toBe(1);
  });

  it("includes the boosted post author's cached profile in a hydrated boost's actorProfiles", async () => {
    const config = freshConfig();
    const author = "https://remote.example/users/bob";
    const boostedNote = "https://remote.example/objects/boosted-note";
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO actor_cache (actor, json, fetched_at) VALUES (?, ?, ?)`,
        author,
        JSON.stringify({ preferredUsername: "bob", name: "Bob Example" }),
        Date.now(),
      );
    });
    // The boosted post itself, held in our inbox, authored by the cached actor.
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/boosted-create",
      type: "Create",
      actor: author,
      object: { id: boostedNote, type: "Note", content: "hi" },
    });
    // A bare-IRI boost of it by someone else.
    await seedActivity(config, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/boost-remote",
      type: "Announce",
      actor: "https://remote.example/users/booster",
      object: boostedNote,
    });
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    const page = await backend.notifications({ limit: 10 });
    const boost = page.entries.find(
      (e) =>
        e.activity["id"] === "https://remote.example/activities/boost-remote",
    );
    expect(boost?.boost?.authorIri).toBe(author);
    // The fix: the boosted author's cached profile is a free DO-local read, so
    // it must be present for the reblog account to render enriched.
    expect(boost?.actorProfiles?.[author]).toMatchObject({
      name: "Bob Example",
    });
  });

  it("entry() returns null for an unparseable id", async () => {
    const config = freshConfig();
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    expect(await backend.entry("not-a-snowflake")).toBeNull();
  });

  it("entry() returns null when no row matches the decoded cursor", async () => {
    const config = freshConfig();
    const backend = buildMastodonBackend({ config, actor: testEnv.ACTOR });
    // A syntactically valid snowflake (decodes cleanly) for a `receivedAtMs`
    // (epoch millisecond 1) that was never stored — real rows are seeded
    // with `Date.now()`, ~1.7e12.
    const phantom = await backend.entry(encodeSnowflake(1, 0));
    expect(phantom).toBeNull();
  });
});
