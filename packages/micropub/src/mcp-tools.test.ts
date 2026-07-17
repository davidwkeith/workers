import { env } from "cloudflare:test";
import type { McpAuthContext, ToolCallResult } from "@dwk/mcp";
import { beforeEach, describe, expect, it } from "vitest";

import { resolveConfig } from "./config.js";
import { createMicropubMcpTools } from "./mcp-tools.js";
import { createMicropubStore, type MicropubStoreEnv } from "./store.js";

const harness = env as unknown as MicropubStoreEnv;

const BASE = "https://example.com";
const ME = "https://alice.example.com/";
const AUTH: McpAuthContext = { scopes: ["create"] };

beforeEach(async () => {
  await createMicropubStore(harness).init();
});

function config() {
  return resolveConfig({
    baseUrl: BASE,
    me: ME,
    micropubEndpoint: `${BASE}/micropub`,
  });
}

function firstTextOf(result: ToolCallResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return JSON.parse(block.text);
}

describe("createMicropubMcpTools", () => {
  it("exposes exactly the micropub_publish tool with the create scope", () => {
    const tools = createMicropubMcpTools({
      config: config(),
      store: createMicropubStore(harness),
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("micropub_publish");
    expect(tools[0]?.requiredScope).toBe("create");
    expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
  });

  it("publishes a post and returns its URL", async () => {
    const store = createMicropubStore(harness);
    const [tool] = createMicropubMcpTools({ config: config(), store });
    const result = await tool!.handler(
      { properties: { content: ["Hello world"] } },
      AUTH,
    );
    expect(result.isError).toBeUndefined();
    const body = firstTextOf(result) as { url: string };
    expect(body.url).toMatch(new RegExp(`^${BASE}/`));

    const record = await store.getPost(body.url);
    expect(record?.properties.content).toEqual(["Hello world"]);
  });

  it("honors a requested mp-slug", async () => {
    const store = createMicropubStore(harness);
    const [tool] = createMicropubMcpTools({ config: config(), store });
    const result = await tool!.handler(
      { properties: { content: ["hi"] }, slug: "my-slug" },
      AUTH,
    );
    const body = firstTextOf(result) as { url: string };
    expect(body.url).toBe(`${BASE}/my-slug`);
  });

  it("dry-runs without persisting the post", async () => {
    const store = createMicropubStore(harness);
    const [tool] = createMicropubMcpTools({ config: config(), store });
    const result = await tool!.handler(
      {
        properties: { content: ["preview me"] },
        slug: "preview-slug",
        dryRun: true,
      },
      AUTH,
    );
    const body = firstTextOf(result) as { dryRun: boolean; url: string };
    expect(body.dryRun).toBe(true);
    expect(body.url).toBe(`${BASE}/preview-slug`);
    expect(await store.getPost(body.url)).toBeNull();
  });

  it("rejects a malformed `properties` argument as a tool error", async () => {
    const store = createMicropubStore(harness);
    const [tool] = createMicropubMcpTools({ config: config(), store });
    const result = await tool!.handler({ properties: "nope" }, AUTH);
    expect(result.isError).toBe(true);
  });

  it("defaults the mf2 type to h-entry", async () => {
    const store = createMicropubStore(harness);
    const [tool] = createMicropubMcpTools({ config: config(), store });
    const result = await tool!.handler(
      { properties: { content: ["typed"] } },
      AUTH,
    );
    const body = firstTextOf(result) as { url: string };
    const record = await store.getPost(body.url);
    expect(record?.type).toBe("h-entry");
  });

  it("uses a custom requiredScope when configured", () => {
    const tools = createMicropubMcpTools({
      config: config(),
      store: createMicropubStore(harness),
      requiredScope: "micropub:publish",
    });
    expect(tools[0]?.requiredScope).toBe("micropub:publish");
  });
});
