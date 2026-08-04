import { env } from "cloudflare:test";
import { createIndieAuthStore } from "@dwk/indieauth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMicrosub, type MicrosubHandler } from "./handler.js";
import type { MicrosubEnv } from "./config.js";
import type { FetchLike } from "@dwk/safe-fetch";
import { createMicrosubStore } from "./store.js";
import { createDpopReplayStore } from "./replay.js";
import {
  authHeaders,
  BASE,
  ME,
  MICROSUB,
  mintToken,
  type MintedToken,
} from "./test-harness.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  items: [
    {
      id: "p1",
      url: "https://blog.example/1",
      title: "First",
      date_published: "2026-01-01T00:00:00Z",
    },
    {
      id: "p2",
      url: "https://blog.example/2",
      title: "Second",
      date_published: "2026-01-02T00:00:00Z",
    },
  ],
});

/** A test env: the real D1 bindings from the pool plus a mock queue. */
function makeEnv(): { env: MicrosubEnv; sent: Array<{ feedUrl: string }> } {
  const sent: Array<{ feedUrl: string }> = [];
  const testEnv = {
    ...(env as unknown as MicrosubEnv),
    MICROSUB_QUEUE: {
      send: vi.fn(async (job: { feedUrl: string }) => {
        sent.push(job);
      }),
    },
  } as unknown as MicrosubEnv;
  return { env: testEnv, sent };
}

function feedFetch(): FetchLike {
  return vi.fn(
    async () =>
      new Response(JSON_FEED, {
        status: 200,
        headers: { "content-type": "application/feed+json" },
      }),
  );
}

function makeHandler(fetchStub?: FetchLike): MicrosubHandler {
  return createMicrosub({
    baseUrl: BASE,
    me: ME,
    pageSize: 20,
    ...(fetchStub ? { fetch: fetchStub } : {}),
  });
}

async function get(
  handler: MicrosubHandler,
  testEnv: MicrosubEnv,
  query: string,
  minted: MintedToken,
): Promise<Response> {
  return handler(
    new Request(`${MICROSUB}?${query}`, {
      headers: await authHeaders(minted, "GET", MICROSUB),
    }),
    testEnv,
    ctx,
  );
}

async function post(
  handler: MicrosubHandler,
  testEnv: MicrosubEnv,
  fields: Record<string, string>,
  minted: MintedToken,
): Promise<Response> {
  const body = new URLSearchParams(fields);
  return handler(
    new Request(MICROSUB, {
      method: "POST",
      headers: {
        ...(await authHeaders(minted, "POST", MICROSUB)),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }),
    testEnv,
    ctx,
  );
}

beforeEach(async () => {
  const harness = env as unknown as MicrosubEnv;
  await createIndieAuthStore(harness).init();
  await createMicrosubStore(harness).init();
  await createDpopReplayStore(harness).init();
});

describe("routing & auth", () => {
  it("answers OPTIONS preflight and rejects unknown paths/methods", async () => {
    const handler = makeHandler();
    const { env: testEnv } = makeEnv();
    expect(
      (
        await handler(
          new Request(MICROSUB, { method: "OPTIONS" }),
          testEnv,
          ctx,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handler(
          new Request(`${BASE}/other`, { method: "GET" }),
          testEnv,
          ctx,
        )
      ).status,
    ).toBe(404);
    expect(
      (await handler(new Request(MICROSUB, { method: "PUT" }), testEnv, ctx))
        .status,
    ).toBe(405);
  });

  it("rejects a missing token, a wrong-owner token, and a missing scope", async () => {
    const handler = makeHandler();
    const { env: testEnv } = makeEnv();

    const noToken = await handler(
      new Request(`${MICROSUB}?action=channels`),
      testEnv,
      ctx,
    );
    expect(noToken.status).toBe(401);

    const wrongOwner = await mintToken(testEnv, "read", "https://eve.example/");
    expect(
      (await get(handler, testEnv, "action=channels", wrongOwner)).status,
    ).toBe(403);

    // Channel creation needs the `channels` scope; a read-only token is refused.
    const readOnly = await mintToken(testEnv, "read");
    expect(
      (
        await post(
          handler,
          testEnv,
          { action: "channels", name: "X" },
          readOnly,
        )
      ).status,
    ).toBe(403);
  });

  it("fails loudly when the queue binding is missing", async () => {
    const handler = makeHandler();
    const brokenEnv = {
      ...(env as unknown as MicrosubEnv),
      MICROSUB_QUEUE: undefined,
    } as unknown as MicrosubEnv;
    const minted = await mintToken(env as unknown as MicrosubEnv, "read");
    const request = new Request(`${MICROSUB}?action=channels`, {
      headers: await authHeaders(minted, "GET", MICROSUB),
    });
    let message = "";
    try {
      await handler(request, brokenEnv, ctx);
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/MICROSUB_QUEUE/);
  });
});

describe("channels", () => {
  it("lists the reserved channel, then creates/renames/reorders/deletes", async () => {
    const handler = makeHandler();
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read channels");

    const list0 = (await (
      await get(handler, testEnv, "action=channels", token)
    ).json()) as {
      channels: Array<{ uid: string; name: string; unread: number }>;
    };
    expect(list0.channels[0]?.uid).toBe("notifications");

    const created = (await (
      await post(
        handler,
        testEnv,
        { action: "channels", name: "Photos" },
        token,
      )
    ).json()) as { uid: string; name: string };
    expect(created.name).toBe("Photos");

    const renamed = (await (
      await post(
        handler,
        testEnv,
        { action: "channels", channel: created.uid, name: "Pics" },
        token,
      )
    ).json()) as { name: string };
    expect(renamed.name).toBe("Pics");

    const ordered = await post(
      handler,
      testEnv,
      { action: "channels", method: "order", "channels[]": created.uid },
      token,
    );
    expect(ordered.status).toBe(200);

    const deleted = await post(
      handler,
      testEnv,
      { action: "channels", method: "delete", channel: created.uid },
      token,
    );
    expect(deleted.status).toBe(200);
  });

  it("refuses to delete or rename the reserved channel and validates input", async () => {
    const handler = makeHandler();
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "channels");

    const del = await post(
      handler,
      testEnv,
      { action: "channels", method: "delete", channel: "notifications" },
      token,
    );
    expect(del.status).toBe(400);

    const rename = await post(
      handler,
      testEnv,
      { action: "channels", channel: "notifications", name: "Nope" },
      token,
    );
    expect(rename.status).toBe(400);

    const noName = await post(handler, testEnv, { action: "channels" }, token);
    expect(noName.status).toBe(400);

    const ghost = await post(
      handler,
      testEnv,
      { action: "channels", method: "delete", channel: "ghost" },
      token,
    );
    expect(ghost.status).toBe(404);
  });
});

describe("following & timeline", () => {
  it("follows a feed, populates the timeline, marks read, and unfollows", async () => {
    const handler = makeHandler(feedFetch());
    const { env: testEnv, sent } = makeEnv();
    const token = await mintToken(testEnv, "read follow channels");

    const channel = (await (
      await post(handler, testEnv, { action: "channels", name: "Blogs" }, token)
    ).json()) as { uid: string };

    const followed = await post(
      handler,
      testEnv,
      {
        action: "follow",
        channel: channel.uid,
        url: "https://blog.example/feed.json",
      },
      token,
    );
    expect(followed.status).toBe(200);
    const followBody = (await followed.json()) as { type: string; url: string };
    expect(followBody).toEqual({
      type: "feed",
      url: "https://blog.example/feed.json",
    });
    // A poll job was enqueued to prime the cache.
    expect(sent).toHaveLength(1);

    // The follow list echoes the page URL.
    const follows = (await (
      await get(handler, testEnv, `action=follow&channel=${channel.uid}`, token)
    ).json()) as { items: Array<{ url: string }> };
    expect(follows.items[0]?.url).toBe("https://blog.example/feed.json");

    // The timeline is populated, newest-first, each entry carrying _id + _is_read.
    const timeline = (await (
      await get(
        handler,
        testEnv,
        `action=timeline&channel=${channel.uid}`,
        token,
      )
    ).json()) as {
      items: Array<{ _id: string; _is_read: boolean; name: string }>;
      paging: Record<string, string>;
    };
    expect(timeline.items.map((i) => i.name)).toEqual(["Second", "First"]);
    expect(timeline.items[0]?._is_read).toBe(false);

    // Mark the first item read; the unread count drops.
    const firstId = timeline.items[0]!._id;
    await post(
      handler,
      testEnv,
      {
        action: "timeline",
        method: "mark_read",
        channel: channel.uid,
        entry: firstId,
      },
      token,
    );
    const channels = (await (
      await get(handler, testEnv, "action=channels", token)
    ).json()) as {
      channels: Array<{ uid: string; unread: number }>;
    };
    expect(channels.channels.find((c) => c.uid === channel.uid)?.unread).toBe(
      1,
    );

    // Unfollow with the page URL the client was given.
    const unfollowed = await post(
      handler,
      testEnv,
      {
        action: "unfollow",
        channel: channel.uid,
        url: "https://blog.example/feed.json",
      },
      token,
    );
    expect(unfollowed.status).toBe(200);
    expect(
      (
        (await (
          await get(
            handler,
            testEnv,
            `action=follow&channel=${channel.uid}`,
            token,
          )
        ).json()) as {
          items: unknown[];
        }
      ).items,
    ).toHaveLength(0);
  });

  it("does not block the follow response on the poll queue send", async () => {
    const handler = makeHandler(feedFetch());
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read follow channels");
    const channel = (await (
      await post(handler, testEnv, { action: "channels", name: "Blogs" }, token)
    ).json()) as { uid: string };

    let resolveSend!: () => void;
    const sendBlocked = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const waited: Promise<unknown>[] = [];
    const waitCtx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    } as unknown as ExecutionContext;
    const blockedEnv = {
      ...testEnv,
      MICROSUB_QUEUE: {
        send: vi.fn(async () => {
          await sendBlocked;
        }),
      },
    } as unknown as MicrosubEnv;

    const followed = await handler(
      new Request(MICROSUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(token, "POST", MICROSUB)),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          action: "follow",
          channel: channel.uid,
          url: "https://blog.example/feed.json",
        }).toString(),
      }),
      blockedEnv,
      waitCtx,
    );

    // The response returns without waiting on the queue send.
    expect(followed.status).toBe(200);
    expect(waited).toHaveLength(1);
    resolveSend();
    await waited[0];
  });

  it("supports mark_unread, last_read_entry, and remove", async () => {
    const handler = makeHandler(feedFetch());
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read follow channels");
    const channel = (await (
      await post(handler, testEnv, { action: "channels", name: "B" }, token)
    ).json()) as { uid: string };
    await post(
      handler,
      testEnv,
      {
        action: "follow",
        channel: channel.uid,
        url: "https://blog.example/feed.json",
      },
      token,
    );

    const items = (await (
      await get(
        handler,
        testEnv,
        `action=timeline&channel=${channel.uid}`,
        token,
      )
    ).json()) as { items: Array<{ _id: string }> };
    const ids = items.items.map((i) => i._id);

    // mark all read through the newest, then mark one back to unread.
    await post(
      handler,
      testEnv,
      {
        action: "timeline",
        method: "mark_read",
        channel: channel.uid,
        last_read_entry: ids[0]!,
      },
      token,
    );
    let unread = await channelUnread(handler, testEnv, token, channel.uid);
    expect(unread).toBe(0);

    await post(
      handler,
      testEnv,
      {
        action: "timeline",
        method: "mark_unread",
        channel: channel.uid,
        entry: ids[0]!,
      },
      token,
    );
    unread = await channelUnread(handler, testEnv, token, channel.uid);
    expect(unread).toBe(1);

    const removed = await post(
      handler,
      testEnv,
      {
        action: "timeline",
        method: "remove",
        channel: channel.uid,
        entry: ids[0]!,
      },
      token,
    );
    expect(removed.status).toBe(200);

    const bad = await post(
      handler,
      testEnv,
      { action: "timeline", method: "bogus", channel: channel.uid },
      token,
    );
    expect(bad.status).toBe(400);
  });

  it("validates channel existence and required params", async () => {
    const handler = makeHandler();
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read follow channels");

    expect((await get(handler, testEnv, "action=timeline", token)).status).toBe(
      400,
    );
    expect(
      (await get(handler, testEnv, "action=timeline&channel=ghost", token))
        .status,
    ).toBe(404);
    expect((await get(handler, testEnv, "action=follow", token)).status).toBe(
      400,
    );
    expect(
      (
        await post(
          handler,
          testEnv,
          { action: "follow", channel: "notifications" },
          token,
        )
      ).status,
    ).toBe(400);
  });
});

describe("preview & search", () => {
  it("previews a feed without subscribing", async () => {
    const handler = makeHandler(feedFetch());
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read");
    const preview = (await (
      await get(
        handler,
        testEnv,
        "action=preview&url=https://blog.example/feed.json",
        token,
      )
    ).json()) as { items: unknown[] };
    expect(preview.items).toHaveLength(2);

    expect((await get(handler, testEnv, "action=preview", token)).status).toBe(
      400,
    );
  });

  it("searches the timeline and discovers feeds by URL", async () => {
    const handler = makeHandler(feedFetch());
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read follow channels");
    const channel = (await (
      await post(handler, testEnv, { action: "channels", name: "B" }, token)
    ).json()) as { uid: string };
    await post(
      handler,
      testEnv,
      {
        action: "follow",
        channel: channel.uid,
        url: "https://blog.example/feed.json",
      },
      token,
    );

    const inChannel = (await (
      await get(
        handler,
        testEnv,
        `action=search&channel=${channel.uid}&query=Second`,
        token,
      )
    ).json()) as { items: Array<{ name: string }> };
    expect(inChannel.items.map((i) => i.name)).toEqual(["Second"]);

    const feedSearch = (await (
      await get(
        handler,
        testEnv,
        "action=search&query=https://blog.example/feed.json",
        token,
      )
    ).json()) as { results: Array<{ type: string; url: string }> };
    expect(feedSearch.results[0]?.type).toBe("feed");

    // A non-URL query with no feed index returns no results.
    const empty = (await (
      await get(handler, testEnv, "action=search&query=cats", token)
    ).json()) as { results: unknown[] };
    expect(empty.results).toEqual([]);
  });

  it("rejects unknown actions", async () => {
    const handler = makeHandler();
    const { env: testEnv } = makeEnv();
    const token = await mintToken(testEnv, "read");
    expect((await get(handler, testEnv, "action=bogus", token)).status).toBe(
      400,
    );
    expect(
      (await post(handler, testEnv, { action: "bogus" }, token)).status,
    ).toBe(400);
  });
});

async function channelUnread(
  handler: MicrosubHandler,
  testEnv: MicrosubEnv,
  token: MintedToken,
  uid: string,
): Promise<number> {
  const channels = (await (
    await get(handler, testEnv, "action=channels", token)
  ).json()) as {
    channels: Array<{ uid: string; unread: number }>;
  };
  return channels.channels.find((c) => c.uid === uid)?.unread ?? -1;
}
