/**
 * Phase 5 (activitypub) end-to-end: the per-actor Durable Object — inbox
 * dedup, the follower/outbox collections, and the signed delivery queue —
 * runs through the host on the emulated Durable Object, exercising the real
 * alarm shim (#379) rather than driving the DO's internal `__deliver` route
 * directly the way `@dwk/activitypub`'s own suite does.
 *
 * This is the first of the four packages issue #380 wires in
 * (`activitypub`, `atproto-pds`, `remotestorage`, `webdav`): it drives an
 * inbound signed `Follow`, watches the DO auto-`Accept` it through a
 * background alarm tick (near-immediate — the accept is enqueued at
 * `next_at = Date.now()`), and separately proves a failed delivery is
 * retried with backoff by the Node host's real `setTimeout`-driven alarm
 * scheduler, not a stubbed clock.
 *
 * Inbound HTTP-signature verification is `@dwk/activitypub`'s own concern
 * (covered by its suite); here `verifyInboxSignature` stands in for it, the
 * same substitution `phase4-solid-pod.integration.test.ts` makes for
 * solid-pod's `authenticate` hook.
 *
 * @see spec/self-hosting.md §7.4, spec/portability.md §5 (Phase 0)
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createActivityPub,
  ActivityPubObject,
  type ActivityPubConfig,
} from "@dwk/activitypub";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const BASE = "https://social.example";
const REMOTE = "https://remote.example/users/alice";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-ap-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString("base64");
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}

async function generateKeyPair(): Promise<{
  publicKeyPem: string;
  privateKeyPem: string;
}> {
  const pair = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicKeyPem: toPem(
      (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
      "PUBLIC KEY",
    ),
    privateKeyPem: toPem(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
      "PRIVATE KEY",
    ),
  };
}

/** Verify-bypass that accepts every inbox POST as signed by REMOTE. */
const acceptAll: ActivityPubConfig["verifyInboxSignature"] = () => ({
  ok: true,
  keyId: `${REMOTE}#main-key`,
  actor: REMOTE,
});

interface Actor {
  readonly origin: string;
  readonly actorUrl: string;
  readonly inboxUrl: string;
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Boot a fresh, isolated actor host (its own data dir → its own DO). */
async function startActor(
  overrides: Partial<ActivityPubConfig> = {},
): Promise<Actor> {
  const dir = dataDir();
  const env = assembleBindings({ dataDir: dir });
  env.ACTOR = createDurableObjectNamespace(ActivityPubObject, {
    dataDir: dir,
    env,
    className: "actor",
  });

  const { publicKeyPem, privateKeyPem } = await generateKeyPair();
  const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
  const config: ActivityPubConfig = {
    baseUrl: BASE,
    actor: { username, name: "Bob" },
    publicKeyPem,
    privateKeyPem,
    verifyInboxSignature: acceptAll,
    ...overrides,
  };
  const handler = createActivityPub(config);
  const actorUrl = `${BASE}/users/${username}`;

  const server = createServer({
    baseUrl: BASE,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/activitypub",
        handler: handler as unknown as FetchHandler,
        reservedPaths: ["/users", "/inbox", "/.well-known/nodeinfo"],
        requires: ["ACTOR"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    actorUrl,
    inboxUrl: `${actorUrl}/inbox`,
    close: () => server.close(),
    send: (method, path, init = {}) =>
      fetch(`${origin}${path}`, { method, ...init }),
  };
}

/** Poll a predicate until it's true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 3000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("Phase 5 — activitypub on the emulated Durable Object", () => {
  it("delivers a signed Accept for an inbound Follow, driven by the real alarm shim", async () => {
    // The DO's outbound delivery calls the *global* `fetch` directly (not an
    // injected `config.fetch`), and so does this test's own HTTP client
    // against the local host — so the stub must pass local-host requests
    // through to the real network and only intercept the simulated remote.
    const seen: { url: string; init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === REMOTE) {
        seen.push({ url: href, init });
        return new Response(
          JSON.stringify({
            id: REMOTE,
            inbox: `${REMOTE}/inbox`,
            publicKey: { owner: REMOTE, publicKeyPem: "irrelevant" },
          }),
          { headers: { "content-type": "application/activity+json" } },
        );
      }
      if (href === `${REMOTE}/inbox`) {
        seen.push({ url: href, init });
        return new Response(null, { status: 202 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    const actor = await startActor();
    try {
      const follow = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/42",
        type: "Follow",
        actor: REMOTE,
        object: actor.actorUrl,
      };
      const res = await actor.send("POST", new URL(actor.inboxUrl).pathname, {
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify(follow),
      });
      expect(res.status).toBe(202);

      // Delivery is alarm-driven, not inline: the host's real Node alarm
      // timer (armed at `next_at = Date.now()`) fires the DO's alarm(),
      // which resolves the follower's inbox and delivers the signed Accept.
      await waitFor(() => seen.some((s) => s.url === `${REMOTE}/inbox`));

      const delivery = seen.find((s) => s.url === `${REMOTE}/inbox`);
      expect(delivery?.init?.method).toBe("POST");
      const headers = delivery?.init?.headers as Record<string, string>;
      expect(headers.Signature).toContain(`keyId="${actor.actorUrl}#main-key"`);
      const raw = delivery?.init?.body as ArrayBufferView;
      const body = JSON.parse(new TextDecoder().decode(raw)) as {
        type: string;
        object: { id: string };
      };
      expect(body.type).toBe("Accept");
      expect(body.object.id).toBe(follow.id);
    } finally {
      globalThis.fetch = originalFetch;
      await actor.close();
    }
  });

  it("retries a failed delivery with backoff through the host's alarm scheduler", async () => {
    let inboxAttempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === REMOTE) {
        return new Response(
          JSON.stringify({
            id: REMOTE,
            inbox: `${REMOTE}/inbox`,
            publicKey: { owner: REMOTE, publicKeyPem: "irrelevant" },
          }),
          { headers: { "content-type": "application/activity+json" } },
        );
      }
      if (href === `${REMOTE}/inbox`) {
        inboxAttempts += 1;
        // Fail the first attempt (retryable) so the delivery is rescheduled
        // with backoff; succeed on the retry.
        return inboxAttempts === 1
          ? new Response("busy", { status: 503 })
          : new Response(null, { status: 202 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    // A tiny base delay so the retry's backoff (base * 2**attempts) fires
    // quickly instead of the 60s production default.
    const actor = await startActor({ deliveryBaseDelayMs: 30 });
    try {
      const follow = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/99",
        type: "Follow",
        actor: REMOTE,
        object: actor.actorUrl,
      };
      const res = await actor.send("POST", new URL(actor.inboxUrl).pathname, {
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify(follow),
      });
      expect(res.status).toBe(202);

      await waitFor(() => inboxAttempts >= 2, { timeoutMs: 5000 });
      expect(inboxAttempts).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      await actor.close();
    }
  });
});
