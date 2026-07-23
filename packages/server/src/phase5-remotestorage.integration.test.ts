/**
 * Phase 5 (remotestorage) end-to-end: the per-account Durable Object —
 * document GET/PUT/DELETE, folder listings, and R2-backed bodies — runs
 * through the host on the emulated DO.
 *
 * Unlike `activitypub`/`atproto-pds`, `remotestorage` needs no DO alarm (its
 * GC is a cron, not alarm-driven), so it was already runnable on this host —
 * it just hadn't been wired into the composed test app. This drives the
 * OAuth-scoped document door over real HTTP.
 *
 * @see spec/self-hosting.md §13
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRemoteStorage,
  RemoteStorageObject,
  bearerToken,
  parseScopes,
} from "@dwk/remotestorage";
import { ensureGcSchema } from "@dwk/store";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-rs-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Vault {
  readonly origin: string;
  send(
    account: string,
    path: string,
    init?: RequestInit & { scope?: string },
  ): Promise<Response>;
  close(): Promise<void>;
}

async function startVault(): Promise<Vault> {
  const dir = dataDir();
  const env = assembleBindings({
    dataDir: dir,
    r2: ["BLOBS"],
    d1: ["GC_DB"],
  }) as Record<string, unknown>;
  env.STORAGE = createDurableObjectNamespace(RemoteStorageObject, {
    dataDir: dir,
    env,
    className: "storage",
  });

  await ensureGcSchema(env.GC_DB as never);

  const baseUrl = "https://storage.example";
  const handler = createRemoteStorage({
    baseUrl,
    // Hermetic auth, matching the package's own suite: the bearer token *is*
    // the scope string, so the host wiring is under test, not JWT/JWKS crypto.
    authenticate: (request) => {
      const token = bearerToken(request);
      return token ? { scopes: parseScopes(token), subject: "tester" } : null;
    },
  });

  const server = createServer({
    baseUrl,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/remotestorage",
        handler: handler as unknown as FetchHandler,
        // remoteStorage routes every path (the first segment is the
        // account), so it claims everything not already reserved.
        reservedPaths: [""],
        requires: ["STORAGE", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    close: () => server.close(),
    send: (account, path, init = {}) => {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string>),
      };
      if (init.scope !== undefined) {
        headers.authorization = `Bearer ${init.scope}`;
      }
      return fetch(`${origin}/${account}${path}`, { ...init, headers });
    },
  };
}

describe("Phase 5 — remotestorage on the emulated Durable Object", () => {
  it("PUTs, GETs, and DELETEs a document with ETags over real HTTP", async () => {
    const vault = await startVault();
    const account = `acct-${crypto.randomUUID()}`;
    try {
      const created = await vault.send(account, "/documents/note.txt", {
        method: "PUT",
        scope: "documents:rw",
        body: "hello",
        headers: { "content-type": "text/plain" },
      });
      expect(created.status).toBe(201);
      const etag = created.headers.get("etag");
      expect(etag).toBeTruthy();

      const read = await vault.send(account, "/documents/note.txt", {
        scope: "documents:r",
      });
      expect(read.status).toBe(200);
      expect(read.headers.get("etag")).toBe(etag);
      expect(await read.text()).toBe("hello");

      const deleted = await vault.send(account, "/documents/note.txt", {
        method: "DELETE",
        scope: "documents:rw",
      });
      expect(deleted.status).toBe(200);

      const gone = await vault.send(account, "/documents/note.txt", {
        scope: "documents:r",
      });
      expect(gone.status).toBe(404);
    } finally {
      await vault.close();
    }
  });

  it("lists a folder with a descendant-sensitive ETag", async () => {
    const vault = await startVault();
    const account = `acct-${crypto.randomUUID()}`;
    try {
      await vault.send(account, "/documents/a.txt", {
        method: "PUT",
        scope: "documents:rw",
        body: "a",
      });
      const folder = await vault.send(account, "/documents/", {
        scope: "documents:r",
      });
      expect(folder.status).toBe(200);
      const body = (await folder.json()) as { items: Record<string, unknown> };
      expect(Object.keys(body.items)).toEqual(["a.txt"]);
    } finally {
      await vault.close();
    }
  });

  it("enforces scopes and account isolation", async () => {
    const vault = await startVault();
    const account = `acct-${crypto.randomUUID()}`;
    try {
      const readOnlyWrite = await vault.send(account, "/documents/x", {
        method: "PUT",
        scope: "documents:r",
        body: "nope",
      });
      expect(readOnlyWrite.status).toBe(403);

      await vault.send(account, "/documents/x", {
        method: "PUT",
        scope: "documents:rw",
        body: "mine",
      });
      const otherAccount = `acct-${crypto.randomUUID()}`;
      const crossRead = await vault.send(otherAccount, "/documents/x", {
        scope: "documents:r",
      });
      expect(crossRead.status).toBe(404);
    } finally {
      await vault.close();
    }
  });
});
