/**
 * Phase 4 (solid-pod) end-to-end: the per-pod Durable Object — the Solid Pod's
 * whole consistency/authz authority — runs through the host on the emulated DO.
 *
 * `@dwk/solid-pod` is the heaviest DO package: every write funnels through the
 * `SolidPodObject` (LDP verbs, `If-Match`, N3 Patch, WAC, DPoP `jti` replay,
 * R2 copy-on-write through `@dwk/store`). This drives it through `createServer`
 * over real HTTP, proving host → `env.POD.idFromName` → in-process DO →
 * `state.storage.sql` + R2 works unchanged on Node.
 *
 * Edge authentication (JWKS + DPoP) is `@dwk/solid-pod`'s own concern and is
 * covered by its suite; here the `authenticate` config hook stands in for it,
 * trusting an `x-test-as` header as the agent WebID, so the test exercises the
 * host wiring and the DO's authorization/storage rather than re-testing crypto.
 *
 * @see spec/self-hosting.md §7.4
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";

import { createSolidPod, SolidPodObject } from "@dwk/solid-pod";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "@dwk/cf-shims";
import type { FetchHandler } from "./config.js";

const OWNER = "https://owner.example/profile#me";
const BOB = "https://bob.example/profile#me";
const TURTLE = "text/turtle";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-pod-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface SendInit {
  /** Authenticate as this WebID via the test `authenticate` hook. */
  readonly as?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface Pod {
  readonly origin: string;
  send(method: string, path: string, init?: SendInit): Promise<Response>;
  close(): Promise<void>;
}

/** Boot a fresh, isolated pod host (its own data dir → its own DO + R2). */
async function startPod(): Promise<Pod> {
  const dir = dataDir();
  const env = assembleBindings({ dataDir: dir, r2: ["BLOBS"] }) as Record<
    string,
    unknown
  >;
  env.POD = createDurableObjectNamespace(SolidPodObject, {
    dataDir: dir,
    env,
    className: "pod",
  });

  const baseUrl = "https://pod.example";
  const handler = createSolidPod({
    baseUrl,
    owner: OWNER,
    // Test-only edge auth: trust `x-test-as` as the agent WebID, standing in for
    // the JWKS + DPoP verification @dwk/solid-pod tests in isolation. A fresh
    // `jti` per call satisfies the DO's write-replay requirement.
    authenticate: (request) => {
      const webid = request.headers.get("x-test-as");
      return webid
        ? { webid, jti: crypto.randomUUID(), jkt: "test-jkt" }
        : null;
    },
  });

  const server = createServer({
    baseUrl,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/solid-pod",
        handler: handler as unknown as FetchHandler,
        reservedPaths: ["/doc", "/blob"],
        requires: ["POD", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    close: () => server.close(),
    send: (method, path, init = {}) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(init.as ? { "x-test-as": init.as } : {}),
          ...(init.headers ?? {}),
        },
        body: init.body,
      }),
  };
}

describe("Phase 4 — solid-pod on the emulated Durable Object", () => {
  it("owner creates, reads, conditionally writes and deletes a resource", async () => {
    const pod = await startPod();
    try {
      // Create (LDP PUT → 201) with an ETag.
      const put = await pod.send("PUT", "/doc", {
        as: OWNER,
        body: "<#a> <#b> <#c> .",
        headers: { "content-type": TURTLE },
      });
      expect(put.status).toBe(201);
      const etag = put.headers.get("etag");
      expect(etag).toBeTruthy();

      // Read it back, parsed into and re-serialised from the DO quad store.
      const get = await pod.send("GET", "/doc", { as: OWNER });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toContain(TURTLE);
      expect(await get.text()).toContain("#b");

      // A stale If-Match loses the optimistic-concurrency check (412).
      const stale = await pod.send("PUT", "/doc", {
        as: OWNER,
        body: "<#a> <#b> <#d> .",
        headers: { "content-type": TURTLE, "if-match": '"wrong"' },
      });
      expect(stale.status).toBe(412);

      // The current ETag wins and advances state (overwrite → 204).
      const update = await pod.send("PUT", "/doc", {
        as: OWNER,
        body: "<#a> <#b> <#d> .",
        headers: { "content-type": TURTLE, "if-match": etag as string },
      });
      expect(update.status).toBe(204);

      // Delete, then it is gone (404).
      expect((await pod.send("DELETE", "/doc", { as: OWNER })).status).toBe(
        204,
      );
      expect((await pod.send("GET", "/doc", { as: OWNER })).status).toBe(404);
    } finally {
      await pod.close();
    }
  });

  it("applies a Solid N3 Patch through the DO", async () => {
    const pod = await startPod();
    try {
      await pod.send("PUT", "/doc", {
        as: OWNER,
        body: "<#a> <#b> <#c> .",
        headers: { "content-type": TURTLE },
      });
      const patch = await pod.send("PATCH", "/doc", {
        as: OWNER,
        body: `_:p a <http://www.w3.org/ns/solid/terms#InsertDeletePatch> ;
  <http://www.w3.org/ns/solid/terms#inserts> { <#x> <#y> <#z> . } .`,
        headers: { "content-type": "text/n3" },
      });
      expect(patch.status).toBe(204);

      const get = await pod.send("GET", "/doc", { as: OWNER });
      expect(await get.text()).toContain("#y");
    } finally {
      await pod.close();
    }
  });

  it("enforces WAC: non-owner is denied, anonymous is challenged", async () => {
    const pod = await startPod();
    try {
      await pod.send("PUT", "/doc", {
        as: OWNER,
        body: "<#a> <#b> <#c> .",
        headers: { "content-type": TURTLE },
      });

      // Authenticated but unauthorised agent → 403.
      expect((await pod.send("GET", "/doc", { as: BOB })).status).toBe(403);
      // No credentials at all → 401 with a DPoP challenge.
      const anon = await pod.send("GET", "/doc");
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toContain("DPoP");
    } finally {
      await pod.close();
    }
  });

  it("delivers change notifications over a WebSocket subscription", async () => {
    const pod = await startPod();
    const wsUrl = `${pod.origin.replace(/^http/, "ws")}/doc`;
    const ws = new WsClient(wsUrl);
    try {
      // Subscribe: the upgrade routes to the DO, which accepts the socket.
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      // A keepalive round-trips through the DO's webSocketMessage override.
      const pong = new Promise<string>((resolve) =>
        ws.once("message", (d: Buffer) => resolve(d.toString())),
      );
      ws.send("ping");
      expect(await pong).toBe("pong");

      // A write fans a notification out to the subscriber.
      const notified = new Promise<string>((resolve) =>
        ws.once("message", (d: Buffer) => resolve(d.toString())),
      );
      const put = await pod.send("PUT", "/doc", {
        as: OWNER,
        body: "<#a> <#b> <#c> .",
        headers: { "content-type": TURTLE },
      });
      expect(put.status).toBe(201);

      const notification = JSON.parse(await notified) as {
        type: string;
        object: string;
      };
      expect(notification.type).toBe("Create");
      expect(notification.object).toContain("/doc");
    } finally {
      ws.close();
      await pod.close();
    }
  });

  it("streams an opaque blob body through R2", async () => {
    const pod = await startPod();
    try {
      const payload = "binary-ish payload   etc";
      const put = await pod.send("PUT", "/blob", {
        as: OWNER,
        body: payload,
        headers: { "content-type": "application/octet-stream" },
      });
      expect(put.status).toBe(201);

      const get = await pod.send("GET", "/blob", { as: OWNER });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toContain(
        "application/octet-stream",
      );
      expect(await get.text()).toBe(payload);
    } finally {
      await pod.close();
    }
  });
});
