import { env } from "cloudflare:test";
import type { McpAuthContext, ToolCallResult } from "@dwk/mcp";
import { describe, expect, it } from "vitest";

import {
  resolveConfig,
  type ResolvedConfig,
  type SolidPodEnv,
} from "./config.js";
import { createSolidPodMcpTools } from "./mcp-tools.js";

const testEnv = env as unknown as SolidPodEnv;

const OWNER = "https://owner.example/profile#me";
const BOB = "https://bob.example/profile#me";

/** A fresh pod config (unique `baseUrl` per test) so DO state never bleeds across tests. */
function freshConfig(
  extra: Partial<Parameters<typeof resolveConfig>[0]> = {},
): ResolvedConfig {
  const baseUrl = `https://${crypto.randomUUID()}.pod.example`;
  return resolveConfig({ baseUrl, owner: OWNER, ...extra });
}

function tools(config: ResolvedConfig) {
  const [read, write] = createSolidPodMcpTools({ config, pod: testEnv.POD });
  if (!read || !write) throw new Error("expected both tools");
  return { read, write };
}

function firstJson(result: ToolCallResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return JSON.parse(block.text);
}

describe("createSolidPodMcpTools", () => {
  it("exposes solid_pod_read and solid_pod_write with expected scopes/annotations", () => {
    const { read, write } = tools(freshConfig());
    expect(read.name).toBe("solid_pod_read");
    expect(read.requiredScope).toBe("read");
    expect(read.annotations?.readOnlyHint).toBe(true);
    expect(write.name).toBe("solid_pod_write");
    expect(write.requiredScope).toBe("write");
    expect(write.annotations?.readOnlyHint).toBe(false);
  });

  it("lets the owner write then read a resource", async () => {
    const config = freshConfig();
    const { read, write } = tools(config);
    const ownerAuth: McpAuthContext = {
      scopes: ["write", "read"],
      subject: OWNER,
    };

    const writeResult = await write.handler(
      { path: "/doc", content: "<#a> <#b> <#c> .", contentType: "text/turtle" },
      ownerAuth,
    );
    expect(writeResult.isError).toBeUndefined();
    expect((firstJson(writeResult) as { url: string }).url).toBe(
      `${config.origin}/doc`,
    );

    const readResult = await read.handler({ path: "/doc" }, ownerAuth);
    expect(readResult.isError).toBeUndefined();
    const block = readResult.content[0];
    expect(block?.type).toBe("text");
    expect((block as { text: string }).text).toContain("#a>");
  });

  it("denies a non-owner read when no ACL governs the resource (WAC, not just MCP scope)", async () => {
    const config = freshConfig();
    const { read, write } = tools(config);
    await write.handler(
      { path: "/doc", content: "<#a> <#b> <#c> ." },
      { scopes: ["write"], subject: OWNER },
    );

    const result = await read.handler(
      { path: "/doc" },
      { scopes: ["read"], subject: BOB },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("403");
  });

  it("allows a public read when the .acl grants foaf:Agent Read", async () => {
    const config = freshConfig();
    const { read, write } = tools(config);
    const ownerAuth: McpAuthContext = { scopes: ["write"], subject: OWNER };
    await write.handler(
      { path: "/pub", content: "<#a> <#b> <#c> ." },
      ownerAuth,
    );
    await write.handler(
      {
        path: "/pub.acl",
        content: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#r> a acl:Authorization ; acl:accessTo <${config.origin}/pub> ;
  acl:agentClass foaf:Agent ; acl:mode acl:Read .`,
      },
      ownerAuth,
    );

    // No `subject` — an anonymous MCP caller (e.g. a public read-only token).
    const result = await read.handler({ path: "/pub" }, { scopes: ["read"] });
    expect(result.isError).toBeUndefined();
  });

  it("refuses solid_pod_write when the auth context has no resolved subject", async () => {
    const { write } = tools(freshConfig());
    const result = await write.handler(
      { path: "/doc", content: "hi" },
      { scopes: ["write"] },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("subject");
  });

  it("rejects a path that does not start with /", async () => {
    const { read } = tools(freshConfig());
    const result = await read.handler(
      { path: "doc" },
      { scopes: ["read"], subject: OWNER },
    );
    expect(result.isError).toBe(true);
  });

  it("dryRun reports the target URL without persisting anything", async () => {
    const config = freshConfig();
    const { read, write } = tools(config);
    const ownerAuth: McpAuthContext = {
      scopes: ["write", "read"],
      subject: OWNER,
    };

    const dryRun = await write.handler(
      { path: "/draft", content: "hi", dryRun: true },
      ownerAuth,
    );
    expect(dryRun.isError).toBeUndefined();
    expect(firstJson(dryRun)).toEqual({
      dryRun: true,
      url: `${config.origin}/draft`,
    });

    const readResult = await read.handler({ path: "/draft" }, ownerAuth);
    expect(readResult.isError).toBe(true);
    expect((readResult.content[0] as { text: string }).text).toContain("404");
  });
});
