import { env } from "cloudflare:test";
import type { McpAuthContext, ToolCallResult } from "@dwk/mcp";
import { describe, expect, it } from "vitest";

import {
  INTERNAL_HEADERS,
  resolveConfig,
  type ActivityPubEnv,
  type ResolvedConfig,
} from "./config.js";
import { forwardedConfig } from "./handler.js";
import { createActivitypubMcpTools } from "./mcp-tools.js";

const testEnv = env as unknown as ActivityPubEnv;
const AUTH: McpAuthContext = { scopes: ["read"] };

function freshConfig(pageSize?: number): ResolvedConfig {
  return resolveConfig({
    baseUrl: "https://social.example",
    actor: { username: `alice-${crypto.randomUUID().slice(0, 8)}` },
    publicKeyPem: "PUBLIC-PEM",
    ...(pageSize !== undefined ? { pageSize } : {}),
  });
}

/** Seed a received activity directly into the DO's inbox table (bypassing HTTP signature verification, which only happens in the front door). */
async function seedInbox(config: ResolvedConfig, id: string): Promise<void> {
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  const activity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "Create",
    actor: "https://remote.example/users/bob",
    object: { id: `${id}/object`, type: "Note", content: "hi" },
  };
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
    throw new Error(`seed failed: ${response.status} ${await response.text()}`);
  }
}

function firstJson(result: ToolCallResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return JSON.parse(block.text);
}

describe("createActivitypubMcpTools", () => {
  it("exposes exactly the activitypub_list_inbox tool with the read scope", () => {
    const tools = createActivitypubMcpTools({
      config: freshConfig(),
      actor: testEnv.ACTOR,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("activitypub_list_inbox");
    expect(tools[0]?.requiredScope).toBe("read");
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists received activities, newest first", async () => {
    const config = freshConfig();
    await seedInbox(config, `${config.iris.id}/activities/1`);
    await seedInbox(config, `${config.iris.id}/activities/2`);
    const [tool] = createActivitypubMcpTools({ config, actor: testEnv.ACTOR });

    const result = await tool!.handler({}, AUTH);
    expect(result.isError).toBeUndefined();
    const body = firstJson(result) as {
      items: { id: string }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id)).toEqual([
      `${config.iris.id}/activities/2`,
      `${config.iris.id}/activities/1`,
    ]);
  });

  it("paginates with page/pageSize", async () => {
    const config = freshConfig();
    await seedInbox(config, `${config.iris.id}/activities/1`);
    await seedInbox(config, `${config.iris.id}/activities/2`);
    await seedInbox(config, `${config.iris.id}/activities/3`);
    const [tool] = createActivitypubMcpTools({ config, actor: testEnv.ACTOR });

    const page1 = firstJson(await tool!.handler({ pageSize: 2 }, AUTH)) as {
      items: { id: string }[];
    };
    expect(page1.items.map((i) => i.id)).toEqual([
      `${config.iris.id}/activities/3`,
      `${config.iris.id}/activities/2`,
    ]);

    const page2 = firstJson(
      await tool!.handler({ page: 2, pageSize: 2 }, AUTH),
    ) as { items: { id: string }[] };
    expect(page2.items.map((i) => i.id)).toEqual([
      `${config.iris.id}/activities/1`,
    ]);
  });

  it("clamps a requested pageSize to maxPageSize", async () => {
    const config = freshConfig(50);
    await seedInbox(config, `${config.iris.id}/activities/1`);
    const [tool] = createActivitypubMcpTools({
      config,
      actor: testEnv.ACTOR,
      maxPageSize: 1,
    });

    const result = firstJson(await tool!.handler({ pageSize: 50 }, AUTH)) as {
      pageSize: number;
    };
    expect(result.pageSize).toBe(1);
  });

  it("rejects a non-number page", async () => {
    const [tool] = createActivitypubMcpTools({
      config: freshConfig(),
      actor: testEnv.ACTOR,
    });
    const result = await tool!.handler({ page: "1" }, AUTH);
    expect(result.isError).toBe(true);
  });
});
