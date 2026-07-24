/**
 * Phase 3 (#432) real Tier-2 lifecycle across two replicas: the same
 * `phase5-activitypub.integration.test.ts` lifecycle (inbound signed `Follow`
 * → alarm-driven signed `Accept`) but composed in `central` storage mode over
 * two independent `DwkServer` replicas sharing one coordination `LibsqlKv` and
 * one set of per-id embedded-replica "primaries" — `@dwk/activitypub`'s
 * `ActivityPubObject` runs completely unmodified; only the binding assembly
 * differs (a `@dwk/deno-host`-backed namespace instead of `@dwk/cf-shims`'s).
 *
 * Unlike local mode, `@dwk/deno-host`'s namespace never auto-arms a timer for
 * a scheduled alarm — each replica must run a `CentralFleetPoller`
 * (spec/scale-out.md §6.3) for the delivery retry to ever fire, exactly as a
 * real deployment would.
 *
 * @see spec/scale-out.md §6, §14 item 2 (the "activitypub Accept-delivery
 * retry as the lifecycle" testing item)
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createActivityPub,
  ActivityPubObject,
  type ActivityPubConfig,
} from "@dwk/activitypub";

import { createCentralServer, type DwkServer } from "./server.js";
import { createCentralDurableObjectNamespace } from "./central-durable-object.js";
import { CentralFleetPoller } from "./central-fleet-poller.js";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeEmbeddedReplicaFactory,
  createFakeEmbeddedReplicaPrimaries,
  createFakeLibsqlClient,
} from "./central-test-harness.js";
import type { FetchHandler } from "./config.js";

const BASE = "https://social.example";
const REMOTE = "https://remote.example/users/alice";

const tempDirs: string[] = [];
const pollers: CentralFleetPoller[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-central-ap-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const poller of pollers.splice(0)) await poller.stop();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
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

interface ReplicaHandle {
  readonly origin: string;
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boot one central-mode replica for the same logical actor: same `baseUrl`/
 * `username` (so `idFromName` derives the same object id on both replicas),
 * same coordination KV and embedded-replica primaries map (so both replicas'
 * namespaces converge on the same lease/storage), but its own `DwkServer`,
 * `dataDir`, and alarm poller — exactly as two independent fleet replicas
 * would each run their own process.
 */
async function startReplica(
  kv: LibsqlKv,
  primaries: Map<string, import("node:sqlite").DatabaseSync>,
  config: ActivityPubConfig,
): Promise<ReplicaHandle> {
  const dir = dataDir();
  const namespace = createCentralDurableObjectNamespace(ActivityPubObject, {
    kv,
    className: "actor",
    env: {},
    getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
    leaseAcquireTimeoutMs: 1000,
  });
  const env = { ACTOR: namespace };
  const handler = createActivityPub(config);

  const server: DwkServer = await createCentralServer({
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
    storage: { mode: "central", kv },
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  const poller = new CentralFleetPoller({
    namespaces: [namespace],
    intervalMs: 20,
    jitterMs: 0,
  });
  poller.start();
  pollers.push(poller);

  return {
    origin,
    close: async () => {
      await poller.stop();
      await server.close();
    },
    send: (method, path, init = {}) =>
      fetch(`${origin}${path}`, { method, ...init }),
  };
}

/** Poll a predicate until it's true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 4000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("central mode — activitypub's actor Durable Object across two replicas", () => {
  it("an inbound Follow on replica A is auto-Accepted via replica B's alarm poll (shared lease + storage)", async () => {
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

    const kv = new LibsqlKv(createFakeLibsqlClient());
    const primaries = createFakeEmbeddedReplicaPrimaries();
    const username = `bob-${crypto.randomUUID().slice(0, 8)}`;
    const { publicKeyPem, privateKeyPem } = await generateKeyPair();
    const config: ActivityPubConfig = {
      baseUrl: BASE,
      actor: { username, name: "Bob" },
      publicKeyPem,
      privateKeyPem,
      verifyInboxSignature: acceptAll,
    };
    const actorUrl = `${BASE}/users/${username}`;

    const replicaA = await startReplica(kv, primaries, config);
    // Replica B never receives the inbound Follow at all — it only polls the
    // shared alarm schedule. Proves the delivery isn't somehow pinned to
    // whichever process happened to accept the inbound POST.
    const replicaB = await startReplica(kv, primaries, config);
    try {
      const follow = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/42",
        type: "Follow",
        actor: REMOTE,
        object: actorUrl,
      };
      const res = await replicaA.send("POST", `/users/${username}/inbox`, {
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify(follow),
      });
      expect(res.status).toBe(202);

      await waitFor(() => seen.some((s) => s.url === `${REMOTE}/inbox`));

      const delivery = seen.find((s) => s.url === `${REMOTE}/inbox`);
      expect(delivery?.init?.method).toBe("POST");
      const headers = delivery?.init?.headers as Record<string, string>;
      expect(headers.Signature).toContain(`keyId="${actorUrl}#main-key"`);
      const raw = delivery?.init?.body as ArrayBufferView;
      const body = JSON.parse(new TextDecoder().decode(raw)) as {
        type: string;
        object: { id: string };
      };
      expect(body.type).toBe("Accept");
      expect(body.object.id).toBe(follow.id);
    } finally {
      globalThis.fetch = originalFetch;
      await replicaA.close();
      await replicaB.close();
    }
  });
});
