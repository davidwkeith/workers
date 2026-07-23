/**
 * Phase 5 (activitypub) end-to-end: the per-actor Durable Object — inbox
 * dedup, follower/outbox collections, and the alarm-driven delivery queue —
 * runs through the host on the emulated DO **and its real alarm timer**.
 *
 * `@dwk/activitypub` was blocked from running on this host at all until the DO
 * alarm shim landed (#379): outbound delivery retries are alarm-driven, not
 * inline. This drives the whole path over real HTTP — a signed `Follow`
 * queues an `Accept`, a transient 503 from the follower's inbox requeues it,
 * and the shim's own timer (not a manual `__deliver` drive, unlike the
 * package's own suite) retries it moments later and it succeeds — proving the
 * host → `env.ACTOR.idFromName` → in-process DO → alarm → signed delivery
 * path works unchanged on Node.
 *
 * @see spec/portability.md §2.3, §5
 * @see spec/self-hosting.md §13
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createActivityPub, ActivityPubObject } from "@dwk/activitypub";
import type { ActivityPubConfig } from "@dwk/activitypub";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

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
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    Buffer.from(binary, "binary")
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
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

interface CapturedFetch {
  readonly url: string;
  readonly init?: RequestInit;
}

interface Actor {
  readonly origin: string;
  /** The actor's real IRI (`baseUrl`-rooted) — what the DO embeds in
   * documents/signatures, distinct from the local HTTP `origin` used to reach
   * the test server. */
  readonly actorIri: string;
  readonly captured: CapturedFetch[];
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boot a fresh, isolated actor host. The DO's own outbound delivery/resolve
 * calls (`#resolveInbox`, `deliverActivity`) always use the bare global
 * `fetch` — a `ForwardedConfig` is JSON over a header, so a custom `fetch`
 * given to {@link createActivityPub} cannot cross that boundary — so
 * `globalThis.fetch` is monkey-patched for the DO's traffic only; calls to the
 * local test server itself go through the untouched original.
 */
async function startActor(
  overrides: Partial<ActivityPubConfig> = {},
  deliveryResponses: (() => Response)[] = [],
): Promise<Actor> {
  const dir = dataDir();
  const env = assembleBindings({ dataDir: dir }) as Record<string, unknown>;
  env.ACTOR = createDurableObjectNamespace(ActivityPubObject, {
    dataDir: dir,
    env,
    className: "actor",
  });

  const baseUrl = "https://social.example";
  const { publicKeyPem, privateKeyPem } = await generateKeyPair();
  const captured: CapturedFetch[] = [];
  const deliveryQueue = [...deliveryResponses];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const href = typeof url === "string" ? url : url.toString();
    if (href === REMOTE) {
      captured.push({ url: href, init });
      return new Response(
        JSON.stringify({
          id: REMOTE,
          inbox: `${REMOTE}/inbox`,
          publicKey: {
            id: `${REMOTE}#main-key`,
            owner: REMOTE,
            publicKeyPem,
          },
        }),
        { headers: { "content-type": "application/activity+json" } },
      );
    }
    if (href === `${REMOTE}/inbox`) {
      captured.push({ url: href, init });
      const next = deliveryQueue.shift();
      return next ? next() : new Response(null, { status: 202 });
    }
    return originalFetch(url, init);
  }) as unknown as typeof fetch;

  const handler = createActivityPub({
    baseUrl,
    actor: { username: "bob", name: "Bob" },
    publicKeyPem,
    privateKeyPem,
    // Fast alarm-driven retries so the test doesn't wait on production timing.
    deliveryBaseDelayMs: 20,
    deliveryMaxAttempts: 5,
    // Bypass inbound HTTP-signature crypto: the host-wiring/DO/alarm path is
    // what's under test here, not signature verification (covered in the
    // package's own suite).
    verifyInboxSignature: () => ({
      ok: true,
      keyId: `${REMOTE}#main-key`,
      actor: REMOTE,
    }),
    ...overrides,
  });

  const server = createServer({
    baseUrl,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/activitypub",
        handler: handler as unknown as FetchHandler,
        reservedPaths: ["/users", "/.well-known/nodeinfo", "/nodeinfo"],
        requires: ["ACTOR"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    actorIri: `${baseUrl}/users/bob`,
    captured,
    close: async () => {
      globalThis.fetch = originalFetch;
      await server.close();
    },
    send: (method, path, init = {}) =>
      originalFetch(`${origin}${path}`, { method, ...init }),
  };
}

describe("Phase 5 — activitypub on the emulated Durable Object", () => {
  it("serves the actor document over real HTTP", async () => {
    const actor = await startActor();
    try {
      const res = await actor.send("GET", "/users/bob");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        type: string;
        preferredUsername: string;
      };
      expect(doc.type).toBe("Person");
      expect(doc.preferredUsername).toBe("bob");
    } finally {
      await actor.close();
    }
  });

  it("delivers a signed Accept after a retryable (503) failure, driven entirely by the shim's real alarm timer", async () => {
    const actor = await startActor({}, [
      () => new Response("try later", { status: 503 }),
    ]);
    try {
      const follow = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/1",
        type: "Follow",
        actor: REMOTE,
        object: actor.actorIri,
      };
      const res = await actor.send("POST", "/users/bob/inbox", {
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify(follow),
      });
      expect(res.status).toBe(202);

      // No manual `__deliver` drive: the DO's own alarm (armed inside the
      // fetch handling of the Follow) must fire on its own, hit the 503,
      // requeue with backoff, and fire again — all through the real timer the
      // shim installed, exactly as it would in production.
      await vi.waitFor(
        () => {
          const delivered = actor.captured.filter(
            (c) => c.url === `${REMOTE}/inbox`,
          );
          expect(delivered.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5_000 },
      );

      const deliveries = actor.captured.filter(
        (c) => c.url === `${REMOTE}/inbox`,
      );
      const headers = deliveries[deliveries.length - 1]?.init
        ?.headers as Record<string, string>;
      expect(headers.Signature).toContain(`keyId="${actor.actorIri}#main-key"`);
      const raw = deliveries[deliveries.length - 1]?.init
        ?.body as ArrayBufferView;
      const body = JSON.parse(new TextDecoder().decode(raw)) as {
        type: string;
        object: { id: string };
      };
      expect(body.type).toBe("Accept");
      expect(body.object.id).toBe(follow.id);
    } finally {
      await actor.close();
    }
  });
});
