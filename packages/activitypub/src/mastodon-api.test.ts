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
