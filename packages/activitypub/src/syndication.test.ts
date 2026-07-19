import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { resolveConfig, type ActivityPubEnv } from "./config.js";
import {
  communityDisplayHandle,
  fetchActorGuarded,
  isHandleShaped,
} from "./discovery.js";
import { createCommunitySyndicationTargets } from "./syndication.js";

const testEnv = env as unknown as ActivityPubEnv;

function freshConfig() {
  return resolveConfig({
    baseUrl: "https://social.example",
    actor: { username: `syn-${crypto.randomUUID().slice(0, 8)}` },
    publicKeyPem: "PUBLIC-PEM",
  });
}

/** Seed a following row directly in the actor's DO. */
async function seedFollowing(
  config: ReturnType<typeof freshConfig>,
  actor: string,
  state: string,
  actorType: string | null,
): Promise<void> {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = testEnv.ACTOR.get(testEnv.ACTOR.idFromName(config.iris.id));
  await runInDurableObject(stub, async (_instance, objectState) => {
    objectState.storage.sql.exec(
      `INSERT INTO following (actor, state, added_at, actor_type) VALUES (?, ?, 1, ?)`,
      actor,
      state,
      actorType,
    );
  });
}

describe("createCommunitySyndicationTargets", () => {
  it("lists accepted Group follows as {uid, name} targets", async () => {
    const config = freshConfig();
    await seedFollowing(
      config,
      "https://lemmy.example/c/birding",
      "accepted",
      "Group",
    );
    await seedFollowing(
      config,
      "https://social.example/users/carol",
      "accepted",
      "Person",
    );
    await seedFollowing(
      config,
      "https://lemmy.example/c/pending",
      "pending",
      "Group",
    );
    const provider = createCommunitySyndicationTargets({
      config,
      actor: testEnv.ACTOR,
    });
    const targets = await provider();
    expect(targets).toEqual([
      {
        uid: "https://lemmy.example/c/birding",
        name: "!birding@lemmy.example",
      },
    ]);
  });

  it("yields an empty list for an actor following no communities", async () => {
    const provider = createCommunitySyndicationTargets({
      config: freshConfig(),
      actor: testEnv.ACTOR,
    });
    expect(await provider()).toEqual([]);
  });
});

describe("discovery helpers", () => {
  it("derives display handles from community IRIs", () => {
    expect(communityDisplayHandle("https://lemmy.example/c/birding")).toBe(
      "!birding@lemmy.example",
    );
    expect(communityDisplayHandle("https://a.example/")).toBe(
      "https://a.example/",
    );
    expect(communityDisplayHandle("not a url")).toBe("not a url");
  });

  it("classifies handles vs IRIs", () => {
    expect(isHandleShaped("!birding@lemmy.example")).toBe(true);
    expect(isHandleShaped("user@host.example")).toBe(true);
    expect(isHandleShaped("https://lemmy.example/c/birding")).toBe(false);
    expect(isHandleShaped("HTTP://x.example")).toBe(false);
  });

  it("caps an untrusted actor document's size", async () => {
    const iri = "https://remote.example/users/huge";
    // Over the 1 MiB cap, with no content-length header — the streaming
    // reader must enforce the ceiling itself.
    const huge = `{"id":"${iri}","pad":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const overCap = await fetchActorGuarded(
      iri,
      async () => new Response(huge, { status: 200 }),
    );
    expect(overCap).toBeNull();

    const fine = await fetchActorGuarded(
      iri,
      async () =>
        new Response(JSON.stringify({ id: iri, type: "Person" }), {
          status: 200,
        }),
    );
    expect(fine).toEqual({ id: iri, type: "Person" });
  });
});
