/**
 * Phase 5 (webdav) end-to-end: the WebDAV "second door" — `@dwk/webdav`'s
 * Class 2 verb router + lock/app-password DO-SQLite stores, resolved by
 * `@dwk/solid-pod`'s `createSolidPodWebdav`/`createSolidPodWebdavCredentials`
 * onto the same per-pod `SolidPodObject` the LDP door uses — runs through the
 * host on the emulated Durable Object.
 *
 * This is the last of the four packages issue #380 wires in
 * (`activitypub`, `atproto-pds`, `remotestorage`, `webdav`). Unlike the other
 * three, `@dwk/webdav` ships no Durable Object of its own: it is mounted here
 * purely through `@dwk/solid-pod`'s exports, over the same `POD` DO
 * namespace / `BLOBS` bucket a plain `createSolidPod` mount would use — no
 * `@dwk/webdav` import is needed in this file at all.
 *
 * The admin (app-password) door and the data door are mounted at distinct
 * paths on one origin (this host has no subdomain-routing story — see
 * `toWebRequest`, which always rebuilds request URLs from the configured
 * `baseUrl` origin); the admin path is listed first so it wins the reserved-
 * path match, and the data door's catch-all (`""`) picks up every other path,
 * exactly the "remoteStorage owns the whole origin" convention
 * `phase5-remotestorage.integration.test.ts` establishes.
 *
 * Owner auth for both doors is `@dwk/solid-pod`'s own concern (covered by its
 * suite); here the `authenticate` hook stands in for it, the same
 * `x-test-as`-trusting substitution `phase4-solid-pod.integration.test.ts`
 * makes.
 *
 * @see spec/self-hosting.md §7.4, spec/portability.md §5 (Phase 0)
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";

import {
  createSolidPodWebdav,
  createSolidPodWebdavCredentials,
  SolidPodObject,
  type SolidPodConfig,
} from "@dwk/solid-pod";
import { ensureGcSchema } from "@dwk/store";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const OWNER = "https://owner.example/profile#me";
const ADMIN_PATH = "/webdav-credentials";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-webdav-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Edge-auth stand-in trusting `x-test-as` as the owner WebID (or anonymous). */
const authenticate: SolidPodConfig["authenticate"] = (request) => {
  const webid = request.headers.get("x-test-as");
  return webid ? { webid, jti: crypto.randomUUID(), jkt: "test-jkt" } : null;
};

interface Pod {
  readonly baseUrl: string;
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Boot a fresh, isolated pod host with both WebDAV doors mounted. */
async function startPod(): Promise<Pod> {
  const dir = dataDir();
  const env = assembleBindings({
    dataDir: dir,
    r2: ["BLOBS"],
    d1: ["GC_DB"],
  });
  env.POD = createDurableObjectNamespace(SolidPodObject, {
    dataDir: dir,
    env,
    className: "pod",
  });
  // The pod DO drains displaced/deleted blobs into the shared D1 GC table on
  // write; stand up the schema up front (mirrors @dwk/solid-pod's own suite).
  await ensureGcSchema(env.GC_DB as D1Database);

  const baseUrl = "https://pod.example";
  const config: SolidPodConfig = { baseUrl, owner: OWNER, authenticate };
  const adminHandler = createSolidPodWebdavCredentials(config);
  const dataHandler = createSolidPodWebdav(config);

  const server = createServer({
    baseUrl,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/solid-pod (webdav admin)",
        handler: adminHandler as unknown as FetchHandler,
        reservedPaths: [ADMIN_PATH],
        requires: ["POD", "BLOBS"],
      },
      {
        name: "@dwk/solid-pod (webdav data)",
        handler: dataHandler as unknown as FetchHandler,
        // The data door owns every resource path (arbitrary Solid pod
        // resource names) — the admin mount above is listed first so its
        // fixed path wins the match ahead of this catch-all.
        reservedPaths: [""],
        requires: ["POD", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => server.close(),
    send: (method, path, init = {}) =>
      fetch(`${origin}${path}`, { method, ...init }),
  };
}

async function mintAppPassword(
  pod: Pod,
): Promise<{ username: string; secret: string }> {
  const res = await pod.send("POST", ADMIN_PATH, {
    headers: { "content-type": "application/json", "x-test-as": OWNER },
    body: JSON.stringify({
      label: "Finder",
      scope: { modes: ["read", "write"] },
    }),
  });
  expect(res.status).toBe(201);
  const minted = (await res.json()) as { username: string; secret: string };
  return minted;
}

function basicAuth(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
}

const LOCKINFO =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
  "<D:locktype><D:write/></D:locktype></D:lockinfo>";

describe("Phase 5 — webdav (over solid-pod) on the emulated Durable Object", () => {
  it("mints an app password through the admin door and drives PUT/LOCK/UNLOCK on the data door", async () => {
    const pod = await startPod();
    try {
      const { username, secret } = await mintAppPassword(pod);
      const auth = basicAuth(username, secret);

      const put = await pod.send("PUT", "/doc.txt", {
        headers: { authorization: auth, "content-type": "text/plain" },
        body: "v1",
      });
      expect(put.status).toBe(201);

      const get = await pod.send("GET", "/doc.txt", {
        headers: { authorization: auth },
      });
      expect(get.status).toBe(200);
      expect(await get.text()).toBe("v1");

      const lock = await pod.send("LOCK", "/doc.txt", {
        headers: {
          authorization: auth,
          depth: "0",
          timeout: "Second-300",
        },
        body: LOCKINFO,
      });
      expect(lock.status).toBe(200);
      const token = lock.headers.get("Lock-Token")?.replace(/^<|>$/g, "");
      expect(token).toMatch(/^opaquelocktoken:/);

      // An unkeyed write against a locked resource is blocked.
      const blocked = await pod.send("PUT", "/doc.txt", {
        headers: { authorization: auth, "content-type": "text/plain" },
        body: "v2",
      });
      expect(blocked.status).toBe(423);

      // The lock token in `If:` admits the write.
      const keyed = await pod.send("PUT", "/doc.txt", {
        headers: {
          authorization: auth,
          "content-type": "text/plain",
          if: `(<${token}>)`,
        },
        body: "v2",
      });
      expect(keyed.status).toBe(204);

      const unlock = await pod.send("UNLOCK", "/doc.txt", {
        headers: { authorization: auth, "lock-token": `<${token}>` },
      });
      expect(unlock.status).toBe(204);

      // Unlocked again: a plain write succeeds without a lock token.
      const after = await pod.send("PUT", "/doc.txt", {
        headers: { authorization: auth, "content-type": "text/plain" },
        body: "v3",
      });
      expect(after.status).toBe(204);
    } finally {
      await pod.close();
    }
  });

  it("COPYs a resource (keeping the source) and MOVEs another (dropping it)", async () => {
    const pod = await startPod();
    try {
      const { username, secret } = await mintAppPassword(pod);
      const auth = basicAuth(username, secret);

      await pod.send("PUT", "/src.txt", {
        headers: { authorization: auth },
        body: "data",
      });

      const copy = await pod.send("COPY", "/src.txt", {
        headers: {
          authorization: auth,
          destination: `${pod.baseUrl}/copy.txt`,
        },
      });
      expect(copy.status).toBe(201);
      expect(
        (
          await pod.send("GET", "/src.txt", {
            headers: { authorization: auth },
          })
        ).status,
      ).toBe(200);
      expect(
        await (
          await pod.send("GET", "/copy.txt", {
            headers: { authorization: auth },
          })
        ).text(),
      ).toBe("data");

      const move = await pod.send("MOVE", "/src.txt", {
        headers: {
          authorization: auth,
          destination: `${pod.baseUrl}/moved.txt`,
        },
      });
      expect(move.status).toBe(201);
      expect(
        (
          await pod.send("GET", "/src.txt", {
            headers: { authorization: auth },
          })
        ).status,
      ).toBe(404);
      expect(
        await (
          await pod.send("GET", "/moved.txt", {
            headers: { authorization: auth },
          })
        ).text(),
      ).toBe("data");
    } finally {
      await pod.close();
    }
  });
});
