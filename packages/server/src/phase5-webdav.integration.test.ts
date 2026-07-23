/**
 * Phase 5 (webdav) end-to-end: the WebDAV "second door" — Class 2 verbs, app
 * passwords, and locks — over the shared per-pod Durable Object, on the
 * emulated DO.
 *
 * `@dwk/webdav` ships no Durable Object of its own: it is a façade over
 * `SolidPodObject` (`createSolidPodWebdav`/`createSolidPodWebdavCredentials`
 * from `@dwk/solid-pod`), so locks and app-password state live in the same
 * consistency domain as the Solid write path. This mints an app password
 * through the real owner-gated admin endpoint (not a direct DO-internals
 * seed), then drives PUT/GET/LOCK/UNLOCK over Basic auth against the same
 * pod the LDP door writes to.
 *
 * @see spec/self-hosting.md §13
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSolidPod,
  createSolidPodWebdav,
  createSolidPodWebdavCredentials,
  SolidPodObject,
} from "@dwk/solid-pod";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const OWNER = "https://owner.example/profile#me";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-webdav-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Pod {
  readonly origin: string;
  /** Mint an app-password credential via the real owner-gated admin endpoint. */
  mintCredential(): Promise<{ username: string; secret: string }>;
  /** Call the WebDAV data door under `/dav`, over Basic auth. */
  dav(
    method: string,
    path: string,
    basic: string,
    init?: { headers?: Record<string, string>; body?: string },
  ): Promise<Response>;
  /**
   * Read a WebDAV-written resource through the LDP handler directly
   * (in-process, bypassing the HTTP mount's own path prefix) as the owner —
   * proof both doors resolve `env.POD.idFromName(baseUrl)` to the same DO
   * instance, since a single Express mount can only own a given path prefix
   * for one handler at a time.
   */
  readViaLdp(path: string): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boot a pod exposing all three doors that share one `SolidPodObject`: the
 * LDP data door (`/doc`, unused here but proves coexistence), the WebDAV data
 * door (`/dav`), and the owner-gated WebDAV credentials admin door
 * (`/webdav-credentials`). Distinct `reservedPaths` route between them on one
 * origin; all three resolve to the same DO instance because they share the
 * same `baseUrl` (the DO id is `idFromName(baseUrl)`).
 */
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
  const ldpHandler = createSolidPod({
    baseUrl,
    owner: OWNER,
    authenticate: (request) => {
      const webid = request.headers.get("x-test-as");
      return webid
        ? { webid, jti: crypto.randomUUID(), jkt: "test-jkt" }
        : null;
    },
  });
  const credentialsHandler = createSolidPodWebdavCredentials({
    baseUrl,
    owner: OWNER,
    authenticate: (request) => {
      const webid = request.headers.get("x-test-as");
      return webid
        ? { webid, jti: crypto.randomUUID(), jkt: "test-jkt" }
        : null;
    },
  });
  const davHandler = createSolidPodWebdav({ baseUrl, owner: OWNER });

  const server = createServer({
    baseUrl,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/solid-pod",
        handler: ldpHandler as unknown as FetchHandler,
        reservedPaths: ["/doc", "/blob"],
        requires: ["POD", "BLOBS"],
      },
      {
        name: "@dwk/solid-pod webdav-credentials",
        handler: credentialsHandler as unknown as FetchHandler,
        reservedPaths: ["/webdav-credentials"],
        requires: ["POD"],
      },
      {
        name: "@dwk/webdav",
        handler: davHandler as unknown as FetchHandler,
        reservedPaths: ["/dav"],
        requires: ["POD", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    close: () => server.close(),
    async mintCredential() {
      const res = await fetch(`${origin}/webdav-credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-as": OWNER },
        body: JSON.stringify({
          label: "integration-test",
          scope: { modes: ["read", "write"] },
        }),
      });
      expect(res.status).toBe(201);
      const minted = (await res.json()) as { username: string; secret: string };
      return minted;
    },
    dav(method, path, basic, init = {}) {
      return fetch(`${origin}/dav${path}`, {
        method,
        headers: { authorization: basic, ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    },
    readViaLdp(path) {
      return ldpHandler(
        new Request(`${baseUrl}${path}`, {
          headers: { "x-test-as": OWNER },
        }),
        env as never,
        {} as ExecutionContext,
      );
    },
  };
}

const LOCKINFO =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
  "<D:locktype><D:write/></D:locktype></D:lockinfo>";

describe("Phase 5 — webdav (the solid-pod second door) on the emulated Durable Object", () => {
  it("mints an app password through the real admin endpoint, then PUTs/GETs over Basic auth", async () => {
    const pod = await startPod();
    try {
      const cred = await pod.mintCredential();
      const basic = `Basic ${Buffer.from(`${cred.username}:${cred.secret}`).toString("base64")}`;

      const put = await pod.dav("PUT", "/note.txt", basic, {
        headers: { "content-type": "text/plain" },
        body: "hello webdav",
      });
      expect(put.status).toBe(201);

      const get = await pod.dav("GET", "/note.txt", basic);
      expect(get.status).toBe(200);
      expect(await get.text()).toBe("hello webdav");
    } finally {
      await pod.close();
    }
  });

  it("locks a resource, blocks an unkeyed write with 423, then admits the keyed one", async () => {
    const pod = await startPod();
    try {
      const cred = await pod.mintCredential();
      const basic = `Basic ${Buffer.from(`${cred.username}:${cred.secret}`).toString("base64")}`;

      await pod.dav("PUT", "/doc.txt", basic, { body: "v1" });
      const lock = await pod.dav("LOCK", "/doc.txt", basic, {
        headers: { depth: "0", timeout: "Second-300" },
        body: LOCKINFO,
      });
      expect(lock.status).toBe(200);
      const token = lock.headers.get("Lock-Token")?.replace(/^<|>$/g, "");
      expect(token).toMatch(/^opaquelocktoken:/);

      const blocked = await pod.dav("PUT", "/doc.txt", basic, { body: "v2" });
      expect(blocked.status).toBe(423);

      const keyed = await pod.dav("PUT", "/doc.txt", basic, {
        body: "v2",
        headers: { if: `(<${token}>)` },
      });
      expect(keyed.status).toBe(204);

      const unlock = await pod.dav("UNLOCK", "/doc.txt", basic, {
        headers: { "lock-token": `<${token}>` },
      });
      expect(unlock.status).toBe(204);

      const afterUnlock = await pod.dav("PUT", "/doc.txt", basic, {
        body: "v3",
      });
      expect(afterUnlock.status).toBe(204);
    } finally {
      await pod.close();
    }
  });

  it("shares one consistency domain with the LDP door: a WebDAV write is readable over Solid", async () => {
    const pod = await startPod();
    try {
      const cred = await pod.mintCredential();
      const basic = `Basic ${Buffer.from(`${cred.username}:${cred.secret}`).toString("base64")}`;

      await pod.dav("PUT", "/shared.txt", basic, {
        headers: { "content-type": "text/plain" },
        body: "seen from both doors",
      });

      // The LDP door and the WebDAV door share one `SolidPodObject`
      // (`idFromName(baseUrl)`), so a WebDAV-written resource is directly
      // readable through the pod's ordinary LDP data door.
      const viaLdp = await pod.readViaLdp("/dav/shared.txt");
      expect(viaLdp.status).toBe(200);
      expect(await viaLdp.text()).toBe("seen from both doors");
    } finally {
      await pod.close();
    }
  });
});
