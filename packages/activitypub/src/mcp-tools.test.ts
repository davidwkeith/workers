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
const WRITE_AUTH: McpAuthContext = { scopes: ["write"] };

function freshConfig(
  pageSize?: number,
  fetchImpl?: typeof fetch,
): ResolvedConfig {
  return resolveConfig({
    baseUrl: "https://social.example",
    actor: { username: `alice-${crypto.randomUUID().slice(0, 8)}` },
    publicKeyPem: "PUBLIC-PEM",
    ...(pageSize !== undefined ? { pageSize } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
  });
}

/** The tool with the given name, from a fresh tool set. */
function toolNamed(
  tools: ReturnType<typeof createActivitypubMcpTools>,
  name: string,
) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
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
  it("exposes publish (write), resolve (read), and list_inbox (read)", () => {
    const tools = createActivitypubMcpTools({
      config: freshConfig(),
      actor: testEnv.ACTOR,
    });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "activitypub_list_inbox",
      "activitypub_publish",
      "activitypub_resolve",
    ]);
    expect(toolNamed(tools, "activitypub_publish").requiredScope).toBe("write");
    expect(
      toolNamed(tools, "activitypub_publish").annotations?.readOnlyHint,
    ).toBe(false);
    expect(toolNamed(tools, "activitypub_resolve").requiredScope).toBe("read");
    expect(
      toolNamed(tools, "activitypub_resolve").annotations?.readOnlyHint,
    ).toBe(true);
    expect(toolNamed(tools, "activitypub_list_inbox").requiredScope).toBe(
      "read",
    );
  });

  it("lists received activities, newest first", async () => {
    const config = freshConfig();
    await seedInbox(config, `${config.iris.id}/activities/1`);
    await seedInbox(config, `${config.iris.id}/activities/2`);
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_list_inbox",
    );

    const result = await tool.handler({}, AUTH);
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
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_list_inbox",
    );

    const page1 = firstJson(await tool.handler({ pageSize: 2 }, AUTH)) as {
      items: { id: string }[];
    };
    expect(page1.items.map((i) => i.id)).toEqual([
      `${config.iris.id}/activities/3`,
      `${config.iris.id}/activities/2`,
    ]);

    const page2 = firstJson(
      await tool.handler({ page: 2, pageSize: 2 }, AUTH),
    ) as { items: { id: string }[] };
    expect(page2.items.map((i) => i.id)).toEqual([
      `${config.iris.id}/activities/1`,
    ]);
  });

  it("clamps a requested pageSize to maxPageSize", async () => {
    const config = freshConfig(50);
    await seedInbox(config, `${config.iris.id}/activities/1`);
    const tool = toolNamed(
      createActivitypubMcpTools({
        config,
        actor: testEnv.ACTOR,
        maxPageSize: 1,
      }),
      "activitypub_list_inbox",
    );

    const result = firstJson(await tool.handler({ pageSize: 50 }, AUTH)) as {
      pageSize: number;
    };
    expect(result.pageSize).toBe(1);
  });

  it("rejects a non-number page", async () => {
    const tool = toolNamed(
      createActivitypubMcpTools({
        config: freshConfig(),
        actor: testEnv.ACTOR,
      }),
      "activitypub_list_inbox",
    );
    const result = await tool.handler({ page: "1" }, AUTH);
    expect(result.isError).toBe(true);
  });
});

describe("activitypub_publish", () => {
  it("publishes a note through the shaped-publish path", async () => {
    const config = freshConfig();
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_publish",
    );
    const result = await tool.handler(
      { kind: "note", content: "<p>hello fediverse</p>" },
      WRITE_AUTH,
    );
    expect(result.isError).toBeUndefined();
    const activity = firstJson(result) as {
      type: string;
      id: string;
      object: { type: string };
    };
    expect(activity.type).toBe("Create");
    expect(activity.object.type).toBe("Note");
    expect(activity.id.startsWith(config.iris.outbox)).toBe(true);
  });

  it("resolves a handle-shaped audience before publishing", async () => {
    const GROUP = "https://lemmy.example/c/birding";
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      expect(url).toContain("lemmy.example/.well-known/webfinger");
      return new Response(
        JSON.stringify({
          links: [
            { rel: "self", type: "application/activity+json", href: GROUP },
          ],
        }),
        { status: 200 },
      );
    };
    const config = freshConfig(undefined, fetchStub);
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_publish",
    );
    const result = await tool.handler(
      {
        kind: "page",
        content: "<p>body</p>",
        name: "Title",
        audience: "!birding@lemmy.example",
      },
      WRITE_AUTH,
    );
    expect(result.isError).toBeUndefined();
    const activity = firstJson(result) as { audience: string };
    expect(activity.audience).toBe(GROUP);
  });

  it("surfaces validation failures as tool errors", async () => {
    const tool = toolNamed(
      createActivitypubMcpTools({
        config: freshConfig(),
        actor: testEnv.ACTOR,
      }),
      "activitypub_publish",
    );
    // A page without a title is rejected by the publish endpoint's validation.
    const result = await tool.handler(
      { kind: "page", content: "<p>x</p>" },
      WRITE_AUTH,
    );
    expect(result.isError).toBe(true);
  });

  it("errors when the audience handle cannot be resolved", async () => {
    const config = freshConfig(
      undefined,
      async () => new Response("nope", { status: 404 }),
    );
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_publish",
    );
    const result = await tool.handler(
      {
        kind: "note",
        content: "x",
        audience: "!missing@lemmy.example",
      },
      WRITE_AUTH,
    );
    expect(result.isError).toBe(true);
  });
});

describe("activitypub_resolve", () => {
  const GROUP = "https://lemmy.example/c/birding";

  it("resolves a community handle to its typed actor", async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/.well-known/webfinger")) {
        return new Response(
          JSON.stringify({
            links: [
              { rel: "self", type: "application/activity+json", href: GROUP },
            ],
          }),
          { status: 200 },
        );
      }
      expect(url).toBe(GROUP);
      return new Response(
        JSON.stringify({
          id: GROUP,
          type: "Group",
          inbox: `${GROUP}/inbox`,
          preferredUsername: "birding",
        }),
        { status: 200 },
      );
    };
    const config = freshConfig(undefined, fetchStub);
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_resolve",
    );
    const result = await tool.handler(
      { handle: "!birding@lemmy.example" },
      AUTH,
    );
    expect(result.isError).toBeUndefined();
    const actor = firstJson(result) as { id: string; type: string };
    expect(actor.id).toBe(GROUP);
    expect(actor.type).toBe("Group");
  });

  it("errors on an unresolvable handle and a bad input", async () => {
    const config = freshConfig(
      undefined,
      async () => new Response("no", { status: 404 }),
    );
    const tool = toolNamed(
      createActivitypubMcpTools({ config, actor: testEnv.ACTOR }),
      "activitypub_resolve",
    );
    expect(
      (await tool.handler({ handle: "!missing@lemmy.example" }, AUTH)).isError,
    ).toBe(true);
    expect((await tool.handler({}, AUTH)).isError).toBe(true);
  });
});

describe("internal DO route hardening", () => {
  it("refuses the __inbox route without the internal marker (defense in depth)", async () => {
    const config = freshConfig();
    const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
    const url = `${config.iris.id}/__inbox`;
    const headers = new Headers();
    headers.set(
      INTERNAL_HEADERS.config,
      JSON.stringify(forwardedConfig(config)),
    );
    // A request carrying only the (front-door-set) config header — as a
    // regressed front-door route that forwarded this path would — is refused.
    const denied = await stub.fetch(new Request(url, { headers }));
    expect(denied.status).toBe(404);
    // The trusted internal caller sets the marker and is served.
    headers.set(INTERNAL_HEADERS.internal, "1");
    const allowed = await stub.fetch(new Request(url, { headers }));
    expect(allowed.status).toBe(200);
  });
});
