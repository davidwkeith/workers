/**
 * Phase 5 (atproto-pds) end-to-end: the per-account repository Durable
 * Object — the signing key, the MST, and the signed commit chain — runs
 * through the host on the emulated Durable Object, driving a record write
 * through the real front door and observing the resulting `#commit` frame
 * on a real HTTP-upgraded `com.atproto.sync.subscribeRepos` WebSocket (the
 * atproto firehose), bridged the same way `phase4-solid-pod.integration.test.ts`
 * bridges Solid's notification WebSocket.
 *
 * This is the second of the four packages issue #380 wires in
 * (`activitypub`, `atproto-pds`, `remotestorage`, `webdav`).
 *
 * @see spec/self-hosting.md §7.4, spec/portability.md §5 (Phase 0)
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";

import {
  createAtprotoPds,
  AtprotoRepoObject,
  decodeCbor,
  encodeFrameHeader,
  CID,
  type AtprotoPdsConfig,
} from "@dwk/atproto-pds";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "@dwk/cf-shims";
import type { FetchHandler } from "./config.js";

const PASSWORD = "correct horse battery staple";
const JWT_SECRET = "jwt-signing-secret";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-atproto-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Account {
  readonly origin: string;
  readonly host: string;
  send(method: string, path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/** Boot a fresh, isolated PDS host (its own data dir → its own DO + R2). */
async function startAccount(): Promise<Account> {
  const dir = dataDir();
  const env = assembleBindings({ dataDir: dir, r2: ["BLOBS"] });
  env.REPO = createDurableObjectNamespace(AtprotoRepoObject, {
    dataDir: dir,
    env,
    className: "repo",
  });

  const host = `${crypto.randomUUID().slice(0, 8)}.example`;
  const config: AtprotoPdsConfig = {
    baseUrl: `https://${host}`,
    password: PASSWORD,
    jwtSecret: JWT_SECRET,
  };
  const handler = createAtprotoPds(config);

  const server = createServer({
    baseUrl: `https://${host}`,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/atproto-pds",
        handler: handler as unknown as FetchHandler,
        reservedPaths: [
          "/.well-known/atproto-did",
          "/.well-known/did.json",
          "/xrpc",
        ],
        requires: ["REPO", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    host,
    close: () => server.close(),
    send: (method, path, init = {}) =>
      fetch(`${origin}${path}`, { method, ...init }),
  };
}

async function login(account: Account): Promise<string> {
  const res = await account.send(
    "POST",
    "/xrpc/com.atproto.server.createSession",
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: account.host,
        password: PASSWORD,
      }),
    },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessJwt: string }).accessJwt;
}

async function createRecord(
  account: Account,
  token: string,
  rkey: string,
  text: string,
): Promise<void> {
  const res = await account.send(
    "POST",
    "/xrpc/com.atproto.repo.createRecord",
    {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        collection: "app.bsky.feed.post",
        rkey,
        record: { $type: "app.bsky.feed.post", text },
      }),
    },
  );
  expect(res.status).toBe(200);
}

const COMMIT_HEADER = encodeFrameHeader("#commit");

/** Split a raw `#commit` firehose frame into its decoded header and body. */
function decodeCommit(frame: Uint8Array): {
  header: { op: number; t: string };
  body: {
    seq: number;
    repo: string;
    commit: CID;
    ops: { action: string; path: string; cid: CID | null }[];
  };
} {
  const header = decodeCbor(frame.slice(0, COMMIT_HEADER.length)) as {
    op: number;
    t: string;
  };
  const body = decodeCbor(frame.slice(COMMIT_HEADER.length)) as never;
  return { header, body };
}

describe("Phase 5 — atproto-pds on the emulated Durable Object", () => {
  it("emits a #commit firehose frame over a real WebSocket upgrade on a record write", async () => {
    const account = await startAccount();
    const wsUrl = `${account.origin.replace(/^http/, "ws")}/xrpc/com.atproto.sync.subscribeRepos`;
    const ws = new WsClient(wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      const nextFrame = new Promise<Uint8Array>((resolve) => {
        ws.once("message", (data: Buffer) => {
          resolve(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          );
        });
      });

      const token = await login(account);
      await createRecord(account, token, "first", "hello firehose");

      const { header, body } = decodeCommit(await nextFrame);
      expect(header).toEqual({ op: 1, t: "#commit" });
      expect(body.seq).toBe(1);
      expect(body.repo).toBe(`did:web:${account.host}`);
      expect(body.ops).toHaveLength(1);
      expect(body.ops[0]).toMatchObject({
        action: "create",
        path: "app.bsky.feed.post/first",
      });
    } finally {
      ws.close();
      await account.close();
    }
  });

  it("round-trips a record through createRecord/getRecord over the front door", async () => {
    const account = await startAccount();
    try {
      const token = await login(account);
      await createRecord(account, token, "note", "hello host");

      const res = await account.send(
        "GET",
        `/xrpc/com.atproto.repo.getRecord?repo=${account.host}&collection=app.bsky.feed.post&rkey=note`,
      );
      expect(res.status).toBe(200);
      const record = (await res.json()) as {
        value: { text: string };
      };
      expect(record.value.text).toBe("hello host");
    } finally {
      await account.close();
    }
  });
});
