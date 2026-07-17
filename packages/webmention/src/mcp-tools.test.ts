import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import type { McpAuthContext, ToolCallResult } from "@dwk/mcp";
import { describe, expect, it } from "vitest";

import { createD1Inbox, type VerifiedMention } from "./inbox.js";
import { createWebmentionMcpTools } from "./mcp-tools.js";

const harness = env as unknown as { WEBMENTION_INBOX: D1Database };
const AUTH: McpAuthContext = { scopes: ["read"] };

function firstTextOf(result: ToolCallResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return JSON.parse(block.text);
}

describe("createWebmentionMcpTools", () => {
  it("exposes webmention_list_received with the read scope by default", () => {
    const tools = createWebmentionMcpTools({
      inbox: createD1Inbox(harness.WEBMENTION_INBOX),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("webmention_list_received");
    expect(tools[0]?.requiredScope).toBe("read");
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists all received mentions newest first when no target is given", async () => {
    const inbox = createD1Inbox(harness.WEBMENTION_INBOX, {
      table: "list_all_mentions",
    });
    const older: VerifiedMention = {
      source: "https://a.example/post",
      target: "https://example.com/post-1",
      verifiedAt: 1,
    };
    const newer: VerifiedMention = {
      source: "https://b.example/post",
      target: "https://example.com/post-2",
      verifiedAt: 2,
    };
    await inbox.store(older);
    await inbox.store(newer);
    const [tool] = createWebmentionMcpTools({ inbox });

    const result = await tool!.handler({}, AUTH);
    const body = firstTextOf(result) as { mentions: VerifiedMention[] };
    expect(body.mentions.map((m) => m.source)).toEqual([
      newer.source,
      older.source,
    ]);
  });

  it("scopes results to a target URL", async () => {
    const inbox = createD1Inbox(harness.WEBMENTION_INBOX, {
      table: "list_scoped_mentions",
    });
    await inbox.store({
      source: "https://a.example/post",
      target: "https://example.com/post-1",
      verifiedAt: 1,
    });
    await inbox.store({
      source: "https://b.example/post",
      target: "https://example.com/post-2",
      verifiedAt: 2,
    });
    const [tool] = createWebmentionMcpTools({ inbox });

    const result = await tool!.handler(
      { target: "https://example.com/post-1" },
      AUTH,
    );
    const body = firstTextOf(result) as { mentions: VerifiedMention[] };
    expect(body.mentions).toHaveLength(1);
    expect(body.mentions[0]?.source).toBe("https://a.example/post");
  });

  it("returns a tool error when `target` is not a string", async () => {
    const inbox = createD1Inbox(harness.WEBMENTION_INBOX, {
      table: "list_invalid_target",
    });
    const [tool] = createWebmentionMcpTools({ inbox });
    const result = await tool!.handler({ target: 42 }, AUTH);
    expect(result.isError).toBe(true);
  });

  it("honors a configured requiredScope", () => {
    const tools = createWebmentionMcpTools({
      inbox: createD1Inbox(harness.WEBMENTION_INBOX),
      requiredScope: "webmention:read",
    });
    expect(tools[0]?.requiredScope).toBe("webmention:read");
  });
});
