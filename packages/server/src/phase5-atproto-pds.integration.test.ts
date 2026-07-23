/**
 * Phase 5 (atproto-pds) end-to-end: the per-account repository Durable Object
 * — the MST, the signed commit chain, and the `did:plc` genesis-registration
 * alarm — runs through the host on the emulated DO **and its real alarm
 * timer**.
 *
 * `@dwk/atproto-pds` was blocked from running on this host at all until the DO
 * alarm shim landed (#379). This drives: a record write producing a `#commit`
 * firehose frame over a real WebSocket (through the same upgrade bridge
 * `solid-pod`'s notifications use), and a `did:plc` genesis submission that
 * fails once and is retried by the shim's own timer — not a manual drive —
 * until it succeeds.
 *
 * @see spec/portability.md §2.3, §5
 * @see spec/self-hosting.md §13
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";

import {
  createAtprotoPds,
  AtprotoRepoObject,
  decodeCbor,
  encodeFrameHeader,
} from "@dwk/atproto-pds";
import type { AtprotoPdsConfig } from "@dwk/atproto-pds";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { createDurableObjectNamespace } from "./shims/durable-object.js";
import type { FetchHandler } from "./config.js";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-pds-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = "correct horse battery staple";
const SECRET = "jwt-signing-secret";
const RESERVED_PATHS = [
  "/xrpc",
  "/.well-known/atproto-did",
  "/.well-known/did.json",
];

interface Pds {
  readonly origin: string;
  send(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function startPds(overrides: Partial<AtprotoPdsConfig> = {}): Promise<{
  pds: Pds;
  host: string;
}> {
  const dir = dataDir();
  const env = assembleBindings({ dataDir: dir, r2: ["BLOBS"] }) as Record<
    string,
    unknown
  >;
  env.REPO = createDurableObjectNamespace(AtprotoRepoObject, {
    dataDir: dir,
    env,
    className: "repo",
  });

  const host = `acct-${crypto.randomUUID().slice(0, 8)}.example`;
  const handler = createAtprotoPds({
    baseUrl: `https://${host}`,
    password: PASSWORD,
    jwtSecret: SECRET,
    ...overrides,
  });

  const server = createServer({
    baseUrl: `https://${host}`,
    dataDir: dir,
    env,
    mounts: [
      {
        name: "@dwk/atproto-pds",
        handler: handler as unknown as FetchHandler,
        reservedPaths: RESERVED_PATHS,
        requires: ["REPO", "BLOBS"],
      },
    ],
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;

  return {
    host,
    pds: {
      origin,
      close: () => server.close(),
      send: (path, init = {}) => fetch(`${origin}${path}`, init),
    },
  };
}

async function login(pds: Pds, host: string): Promise<string> {
  const res = await pds.send("/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: host, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessJwt: string }).accessJwt;
}

async function createRecord(
  pds: Pds,
  token: string,
  rkey: string,
  text: string,
): Promise<void> {
  const res = await pds.send("/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      collection: "app.bsky.feed.post",
      rkey,
      record: { $type: "app.bsky.feed.post", text },
    }),
  });
  expect(res.status).toBe(200);
}

const COMMIT_HEADER = encodeFrameHeader("#commit");

/** Split a `#commit` frame (two concatenated DAG-CBOR values) into header + body. */
function decodeCommit(frame: Uint8Array): {
  header: { op: number; t: string };
  body: {
    seq: number;
    repo: string;
    commit: unknown;
    ops: { action: string; path: string }[];
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
  it("writes a record and streams a #commit frame over a real WebSocket firehose", async () => {
    const { pds, host } = await startPds();
    try {
      const token = await login(pds, host);

      const wsUrl = `${pds.origin.replace(/^http/, "ws")}/xrpc/com.atproto.sync.subscribeRepos`;
      const ws = new WsClient(wsUrl);
      const frame = new Promise<Buffer>((resolve, reject) => {
        ws.once("message", (data: Buffer) => resolve(data));
        ws.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      await createRecord(pds, token, "first", "hello firehose");

      const { header, body } = decodeCommit(new Uint8Array(await frame));
      expect(header).toEqual({ op: 1, t: "#commit" });
      expect(body.seq).toBe(1);
      expect(body.repo).toBe(`did:web:${host}`);
      expect(body.ops).toHaveLength(1);
      expect(body.ops[0]).toMatchObject({
        action: "create",
        path: "app.bsky.feed.post/first",
      });

      // The record is actually readable back over the ordinary XRPC surface.
      const get = await pds.send(
        "/xrpc/com.atproto.repo.getRecord?collection=app.bsky.feed.post&rkey=first",
      );
      expect(get.status).toBe(200);
      const record = (await get.json()) as { value: { text: string } };
      expect(record.value.text).toBe("hello firehose");

      ws.close();
    } finally {
      await pds.close();
    }
  });

  it(
    "retries a did:plc genesis submission via the shim's real alarm timer until the directory accepts it",
    { timeout: 20_000 },
    async () => {
      // The directory host must parse as a plain (non-IP) hostname so
      // `@dwk/safe-fetch`'s host check passes; `globalThis.fetch` is
      // monkey-patched before any real network call is attempted.
      const directoryHost = "plc.invalid";
      const directoryUrl = `https://${directoryHost}`;
      let attempts = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (
        url: string | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const href = typeof url === "string" ? url : url.toString();
        if (href.startsWith(directoryUrl)) {
          attempts += 1;
          if (attempts < 2) {
            return new Response("try again later", { status: 500 });
          }
          return new Response(null, { status: 200 });
        }
        return originalFetch(url, init);
      }) as unknown as typeof fetch;

      const { pds, host } = await startPds({
        didMethod: "plc",
        plcDirectoryUrl: directoryUrl,
      });
      try {
        // Any request lazily initialises the repo (genesis commit + schedule
        // the PLC submission alarm at `Date.now()` — fire ASAP).
        const token = await login(pds, host);
        expect(token).toBeTruthy();

        // No manual drive: the DO's real alarm timer must retry the rejected
        // submission on its own (a fixed ~10s backoff after the first
        // failure — `PLC_SUBMIT_BASE_MS`, not configurable) until the
        // directory accepts it.
        await vi.waitFor(
          () => {
            expect(attempts).toBeGreaterThanOrEqual(2);
          },
          { timeout: 15_000 },
        );
      } finally {
        globalThis.fetch = originalFetch;
        await pds.close();
      }
    },
  );
});
