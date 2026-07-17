import { env } from "cloudflare:test";
import type { McpAuthContext, ToolCallResult } from "@dwk/mcp";
import { describe, expect, it, vi } from "vitest";

import { createMicrosubMcpTools } from "./mcp-tools.js";
import {
  createMicrosubStore,
  NOTIFICATIONS_CHANNEL,
  type MicrosubStoreEnv,
} from "./store.js";
import type { Jf2Entry } from "./jf2.js";

const harness = env as unknown as MicrosubStoreEnv;
const AUTH: McpAuthContext = { scopes: [] };

function firstTextOf(result: ToolCallResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return JSON.parse(block.text);
}

function entry(id: string, published: string): Jf2Entry {
  return {
    type: "entry",
    _id: id,
    published,
    content: { text: `entry ${id}` },
  } as Jf2Entry;
}

describe("createMicrosubMcpTools", () => {
  it("exposes microsub_list_channels and microsub_get_timeline, no scope required by default", () => {
    const tools = createMicrosubMcpTools({
      store: createMicrosubStore(harness),
    });
    expect(tools.map((t) => t.name)).toEqual([
      "microsub_list_channels",
      "microsub_get_timeline",
    ]);
    expect(tools.every((t) => t.requiredScope === "")).toBe(true);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("lists channels with unread counts", async () => {
    const store = createMicrosubStore(harness);
    await store.createChannel("Home", 1);
    const [listChannels] = createMicrosubMcpTools({ store });

    const result = await listChannels!.handler({}, AUTH);
    const body = firstTextOf(result) as {
      channels: { uid: string; name: string; unread: number }[];
    };
    expect(body.channels.some((c) => c.name === "Home")).toBe(true);
    expect(
      body.channels.find((c) => c.uid === NOTIFICATIONS_CHANNEL)?.unread,
    ).toBe(0);
  });

  it("fetches a channel's timeline newest-first", async () => {
    const store = createMicrosubStore(harness);
    const channel = await store.createChannel("Reader", 1);
    await store.insertItems(
      channel.uid,
      "https://feed.example/",
      [entry("a", "2026-01-01T00:00:00Z"), entry("b", "2026-01-02T00:00:00Z")],
      1,
      100,
    );
    const [, getTimeline] = createMicrosubMcpTools({ store });

    const result = await getTimeline!.handler({ channel: channel.uid }, AUTH);
    const body = firstTextOf(result) as { items: Jf2Entry[] };
    expect(body.items.map((i) => i._id)).toEqual(["b", "a"]);
  });

  it("respects a custom limit", async () => {
    const store = createMicrosubStore(harness);
    const channel = await store.createChannel("Reader2", 1);
    await store.insertItems(
      channel.uid,
      "https://feed.example/",
      [entry("a", "2026-01-01T00:00:00Z"), entry("b", "2026-01-02T00:00:00Z")],
      1,
      100,
    );
    const [, getTimeline] = createMicrosubMcpTools({ store });

    const result = await getTimeline!.handler(
      { channel: channel.uid, limit: 1 },
      AUTH,
    );
    const body = firstTextOf(result) as { items: Jf2Entry[] };
    expect(body.items).toHaveLength(1);
  });

  it("clamps a requested limit above the configured maximum", async () => {
    const store = createMicrosubStore(harness);
    const channel = await store.createChannel("Reader3", 1);
    const [, getTimeline] = createMicrosubMcpTools({ store, maxLimit: 5 });
    const listItemsSpy = vi.spyOn(store, "listItems");

    await getTimeline!.handler({ channel: channel.uid, limit: 1000 }, AUTH);

    expect(listItemsSpy).toHaveBeenCalledWith(
      channel.uid,
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("returns a tool error for an unknown channel", async () => {
    const store = createMicrosubStore(harness);
    const [, getTimeline] = createMicrosubMcpTools({ store });
    const result = await getTimeline!.handler({ channel: "no-such" }, AUTH);
    expect(result.isError).toBe(true);
  });

  it("returns a tool error when `channel` is missing", async () => {
    const store = createMicrosubStore(harness);
    const [, getTimeline] = createMicrosubMcpTools({ store });
    const result = await getTimeline!.handler({}, AUTH);
    expect(result.isError).toBe(true);
  });

  it("honors a configured requiredScope", () => {
    const tools = createMicrosubMcpTools({
      store: createMicrosubStore(harness),
      requiredScope: "read",
    });
    expect(tools.every((t) => t.requiredScope === "read")).toBe(true);
  });
});
