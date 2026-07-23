/**
 * Phase 5 (remotestorage) end-to-end: the per-account Durable Object — the
 * `@dwk/store`-backed document vault — runs through the host on the
 * emulated Durable Object, and the R2 GC cron (mirroring
 * `@dwk/solid-pod`'s, exercised in `phase3.integration.test.ts`) reclaims a
 * blob the DO orphaned on overwrite.
 *
 * This is the third of the four packages issue #380 wires in
 * (`activitypub`, `atproto-pds`, `remotestorage`, `webdav`).
 *
 * For hermetic auth the injected `authenticate` hook treats the bearer token
 * *as* the scope string (`Authorization: Bearer documents:rw`), exactly as
 * `@dwk/remotestorage`'s own suite does — the built-in JWKS verifier is that
 * package's concern, not the host wiring's.
 *
 * @see spec/self-hosting.md §7.4, spec/portability.md §5 (Phase 0)
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import {
  createRemoteStorage,
  createRemoteStorageGc,
  RemoteStorageObject,
  bearerToken,
  parseScopes,
  type RemoteStorageConfig,
} from "@dwk/remotestorage";
import { DEFAULT_MAX_INLINE_BYTES, ensureGcSchema } from "@dwk/store";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { bindScheduledTask } from "./lifecycle.js";
import { WaitUntilTracker } from "./context.js";
import { CronScheduler } from "./shims/cron.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const BASE = "https://storage.example";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-rs-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Auth hook treating the bearer token as the scope string, per the package's own suite. */
const authenticate: RemoteStorageConfig["authenticate"] = (request) => {
  const token = bearerToken(request);
  return token ? { scopes: parseScopes(token), subject: "tester" } : null;
};

interface Vault {
  readonly env: Record<string, unknown>;
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Boot a fresh, isolated vault host (its own data dir → its own DO + R2 + GC_DB). */
async function startVault(): Promise<Vault> {
  const dir = dataDir();
  const env = assembleBindings({
    dataDir: dir,
    r2: ["BLOBS"],
    d1: ["GC_DB"],
  });
  env.STORAGE = createDurableObjectNamespace(RemoteStorageObject, {
    dataDir: dir,
    env,
    className: "storage",
  });
  // The DO forwards orphaned blob keys into GC_DB on write; the schema is
  // normally stood up by the GC cron's own bindings, but a write can race it,
  // so create it up front (mirrors @dwk/remotestorage's own suite).
  await ensureGcSchema(env.GC_DB as D1Database);

  const handler = createRemoteStorage({ baseUrl: BASE, authenticate });

  const server = createServer({
    baseUrl: BASE,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/remotestorage",
        handler: handler as unknown as FetchHandler,
        // remoteStorage owns the whole origin (the account is the first path
        // segment, arbitrary per request) — "" matches every pathname since
        // `isReservedPath` checks `pathname.startsWith(`${entry}/`)`.
        reservedPaths: [""],
        requires: ["STORAGE", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    env,
    close: () => server.close(),
    send: (method, path, init = {}) =>
      fetch(`${origin}${path}`, { method, ...init }),
  };
}

describe("Phase 5 — remotestorage on the emulated Durable Object", () => {
  it("owner writes, reads, and deletes a document over the front door", async () => {
    const vault = await startVault();
    try {
      const account = `acct-${crypto.randomUUID()}`;
      const path = `/${account}/documents/note.txt`;

      const put = await vault.send("PUT", path, {
        headers: {
          authorization: "Bearer documents:rw",
          "content-type": "text/plain",
        },
        body: "hello vault",
      });
      expect(put.status).toBe(201);
      const etag = put.headers.get("etag");
      expect(etag).toBeTruthy();

      const get = await vault.send("GET", path, {
        headers: { authorization: "Bearer documents:r" },
      });
      expect(get.status).toBe(200);
      expect(await get.text()).toBe("hello vault");

      // No scope for the module → 403.
      const forbidden = await vault.send("GET", path, {
        headers: { authorization: "Bearer other:r" },
      });
      expect(forbidden.status).toBe(403);

      // No credentials at all → 401 (not a public document).
      const anon = await vault.send("GET", path);
      expect(anon.status).toBe(401);

      const del = await vault.send("DELETE", path, {
        headers: { authorization: "Bearer documents:rw" },
      });
      expect(del.status).toBe(200);
      expect(
        (
          await vault.send("GET", path, {
            headers: { authorization: "Bearer documents:r" },
          })
        ).status,
      ).toBe(404);
    } finally {
      await vault.close();
    }
  });

  it("reclaims an overwritten document's orphaned blob from the GC cron", async () => {
    const vault = await startVault();
    try {
      const account = `acct-${crypto.randomUUID()}`;
      const path = `/${account}/documents/note.txt`;

      // Every remoteStorage document write goes through `store.putBlob` to
      // R2 regardless of size — size only picks the *hashing* path: a
      // declared Content-Length over `maxInlineBytes` streams straight to
      // `putBlob` (hitting `stageAndHash`'s `crypto.DigestStream`, the
      // polyfill this PR adds), while a smaller body is buffered and hashed
      // directly. Exceed the ceiling here so this test exercises the
      // streamed path, not just the buffered one.
      const big = "x".repeat(DEFAULT_MAX_INLINE_BYTES + 1024);
      await vault.send("PUT", path, {
        headers: {
          authorization: "Bearer documents:rw",
          "content-type": "text/plain",
        },
        body: big,
      });
      const initial = await (vault.env.BLOBS as R2Bucket).list();
      expect(initial.objects.length).toBeGreaterThan(0);

      // Overwrite: every remoteStorage document write goes through
      // `store.putBlob` (not just large ones), so the old R2 blob is
      // displaced (copy-on-write, a fresh key for the new body) and forwarded
      // to GC_DB as an orphan — R2 briefly holds both keys.
      await vault.send("PUT", path, {
        headers: {
          authorization: "Bearer documents:rw",
          "content-type": "text/plain",
        },
        body: "replacement",
      });
      const beforeGc = await (vault.env.BLOBS as R2Bucket).list();
      expect(beforeGc.objects.length).toBe(initial.objects.length + 1);

      const tracker = new WaitUntilTracker();
      const cron = new CronScheduler();
      cron.register(
        bindScheduledTask(
          createRemoteStorageGc({ baseUrl: BASE, gcSafetyWindowMs: 0 }),
          vault.env,
          tracker,
        ),
        3_600_000,
        "0 * * * *",
      );
      await cron.fireAll();

      const afterGc = await (vault.env.BLOBS as R2Bucket).list();
      expect(afterGc.objects.length).toBe(beforeGc.objects.length - 1);
    } finally {
      await vault.close();
    }
  });
});
