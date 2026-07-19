import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createActivityPub } from "./handler.js";
import type { ActivityPubEnv } from "./config.js";

/**
 * Front-door community discovery (§2.4): a handle-shaped `audience` on the
 * shaped-post publish endpoint resolves to its Group actor IRI via WebFinger
 * (the `@dwk/webfinger` JRD helper behind the SSRF guard) before the request
 * reaches the Durable Object.
 */

const testEnv = env as unknown as ActivityPubEnv;
const BASE = "https://social.example";
const GROUP = "https://lemmy.example/c/birding";

const JRD = {
  subject: "acct:birding@lemmy.example",
  links: [{ rel: "self", type: "application/activity+json", href: GROUP }],
};

function makeHandler(fetchImpl: typeof fetch) {
  const username = `handle-${crypto.randomUUID().slice(0, 8)}`;
  const handler = createActivityPub({
    baseUrl: BASE,
    actor: { username },
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    publishToken: "s3cret",
    fetch: fetchImpl,
  });
  return { handler, username };
}

function publishRequest(username: string, body: unknown): Request {
  return new Request(`${BASE}/users/${username}/publish`, {
    method: "POST",
    headers: {
      authorization: "Bearer s3cret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const ctx = {} as ExecutionContext;

describe("handle-shaped audience resolution", () => {
  it("resolves a !community@host handle to the Group IRI before publishing", async () => {
    let webfingerCalls = 0;
    const { handler, username } = makeHandler(async (input) => {
      webfingerCalls += 1;
      expect(String(input)).toBe(
        "https://lemmy.example/.well-known/webfinger?resource=acct%3Abirding%40lemmy.example",
      );
      return new Response(JSON.stringify(JRD), { status: 200 });
    });
    const res = await handler(
      publishRequest(username, {
        kind: "page",
        content: "<p>body</p>",
        name: "Title",
        audience: "!birding@lemmy.example",
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(webfingerCalls).toBe(1);
    const activity = (await res.json()) as Record<string, unknown>;
    expect(activity.audience).toBe(GROUP);
  });

  it("400s when the handle cannot be resolved", async () => {
    const { handler, username } = makeHandler(
      async () => new Response("nope", { status: 404 }),
    );
    const res = await handler(
      publishRequest(username, {
        kind: "note",
        content: "x",
        audience: "!missing@lemmy.example",
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/could not be resolved/);
  });

  it("passes an IRI audience through without any lookup", async () => {
    const { handler, username } = makeHandler(async () => {
      throw new Error("must not fetch");
    });
    const res = await handler(
      publishRequest(username, {
        kind: "note",
        content: "x",
        audience: GROUP,
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(201);
    const activity = (await res.json()) as Record<string, unknown>;
    expect(activity.audience).toBe(GROUP);
  });
});
