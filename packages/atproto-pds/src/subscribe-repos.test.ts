import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { readCar } from "./car.js";
import { decodeCbor } from "./cbor.js";
import { CID } from "./cid.js";
import { encodeErrorFrame, encodeFrameHeader } from "./firehose.js";
import { createAtprotoPds, type AtprotoPdsEnv } from "./index.js";

/**
 * The repository firehose (`com.atproto.sync.subscribeRepos`) over the real
 * front door + per-account Durable Object: a `#commit` frame per write, the
 * `blocks` CAR diff a consumer applies, `?cursor=` backfill, and the
 * future-cursor error path. Without this stream a PDS's records are invisible to
 * Relays, so these are the network-reachability tests.
 */

const testEnv = env as unknown as AtprotoPdsEnv;
const ctx = {} as ExecutionContext;
const PASSWORD = "correct horse battery staple";
const SECRET = "jwt-signing-secret";

function pds(host: string) {
  return createAtprotoPds({
    baseUrl: `https://${host}`,
    password: PASSWORD,
    jwtSecret: SECRET,
  });
}

type Handler = ReturnType<typeof pds>;

async function login(handler: Handler, host: string): Promise<string> {
  const res = await handler(
    new Request(`https://${host}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: host, password: PASSWORD }),
    }),
    testEnv,
    ctx,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessJwt: string }).accessJwt;
}

async function createRecord(
  handler: Handler,
  host: string,
  token: string,
  rkey: string,
  text: string,
): Promise<void> {
  const res = await handler(
    new Request(`https://${host}/xrpc/com.atproto.repo.createRecord`, {
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
    }),
    testEnv,
    ctx,
  );
  expect(res.status).toBe(200);
}

/** A FIFO reader over a WebSocket's binary frames (resolves them as Uint8Array). */
function frames(ws: WebSocket): { next(): Promise<Uint8Array> } {
  const buffered: Uint8Array[] = [];
  const waiting: ((frame: Uint8Array) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const data =
      event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new TextEncoder().encode(event.data as string);
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else buffered.push(data);
  });
  return {
    next() {
      const ready = buffered.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<Uint8Array>((resolve) => waiting.push(resolve));
    },
  };
}

/** Open a firehose subscription; the message listener is attached before accept. */
async function subscribe(
  handler: Handler,
  host: string,
  query = "",
): Promise<{ ws: WebSocket; reader: ReturnType<typeof frames> }> {
  const res = await handler(
    new Request(
      `https://${host}/xrpc/com.atproto.sync.subscribeRepos${query}`,
      { headers: { upgrade: "websocket" } },
    ),
    testEnv,
    ctx,
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("expected a WebSocket on the 101 response");
  const reader = frames(ws);
  ws.accept();
  return { ws, reader };
}

const COMMIT_HEADER = encodeFrameHeader("#commit");

/** Split a `#commit` frame into its decoded header and body. */
function decodeCommit(frame: Uint8Array): {
  header: { op: number; t: string };
  body: {
    seq: number;
    repo: string;
    commit: CID;
    rev: string;
    since: string | null;
    blocks: Uint8Array;
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

describe("subscribeRepos firehose", () => {
  it("rejects a plain GET without a WebSocket upgrade", async () => {
    const host = "fh-noupgrade.example";
    const res = await pds(host)(
      new Request(`https://${host}/xrpc/com.atproto.sync.subscribeRepos`),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "InvalidRequest",
    });
  });

  it("emits a #commit frame on a record write, with an applicable blocks CAR", async () => {
    const host = "fh-live.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const { reader } = await subscribe(handler, host);

    await createRecord(handler, host, token, "first", "hello firehose");

    const { header, body } = decodeCommit(await reader.next());
    expect(header).toEqual({ op: 1, t: "#commit" });
    expect(body.seq).toBe(1);
    expect(body.repo).toBe(`did:web:${host}`);
    expect(body.rev).toBeTruthy();
    // The first record commit chains from the (empty) genesis commit, so `since`
    // is that prior revision, not null.
    expect(body.since).toBeTruthy();
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0]).toMatchObject({
      action: "create",
      path: "app.bsky.feed.post/first",
    });
    const opCid = body.ops[0]!.cid as CID;

    // The blocks CAR is self-contained enough to apply the commit: its root is
    // the new commit, and it carries the created record's block.
    const car = readCar(body.blocks);
    expect(car.roots[0]!.toString()).toBe((body.commit as CID).toString());
    expect(car.blocks.some((b) => b.cid.equals(body.commit as CID))).toBe(true);
    expect(car.blocks.some((b) => b.cid.equals(opCid))).toBe(true);
  });

  it("assigns monotonic seqs across writes and reports deletes", async () => {
    const host = "fh-seq.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const { reader } = await subscribe(handler, host);

    await createRecord(handler, host, token, "a", "one");
    await createRecord(handler, host, token, "b", "two");
    await handler(
      new Request(`https://${host}/xrpc/com.atproto.repo.deleteRecord`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ collection: "app.bsky.feed.post", rkey: "a" }),
      }),
      testEnv,
      ctx,
    );

    const first = decodeCommit(await reader.next());
    const second = decodeCommit(await reader.next());
    const third = decodeCommit(await reader.next());
    expect([first.body.seq, second.body.seq, third.body.seq]).toEqual([
      1, 2, 3,
    ]);
    expect(third.body.ops[0]).toMatchObject({
      action: "delete",
      path: "app.bsky.feed.post/a",
      cid: null,
    });
  });

  it("backfills buffered events from ?cursor= then continues live", async () => {
    const host = "fh-cursor.example";
    const handler = pds(host);
    const token = await login(handler, host);

    // Two writes with no subscriber connected — they land only in the buffer.
    await createRecord(handler, host, token, "a", "one");
    await createRecord(handler, host, token, "b", "two");

    // cursor=0 replays everything after seq 0.
    const { reader } = await subscribe(handler, host, "?cursor=0");
    expect(decodeCommit(await reader.next()).body.seq).toBe(1);
    expect(decodeCommit(await reader.next()).body.seq).toBe(2);

    // A subsequent write streams live on the same socket.
    await createRecord(handler, host, token, "c", "three");
    expect(decodeCommit(await reader.next()).body.seq).toBe(3);
  });

  it("replays only events after a mid-stream cursor", async () => {
    const host = "fh-midcursor.example";
    const handler = pds(host);
    const token = await login(handler, host);
    await createRecord(handler, host, token, "a", "one");
    await createRecord(handler, host, token, "b", "two");

    const { reader } = await subscribe(handler, host, "?cursor=1");
    // Only seq 2 is after the cursor; the next frame is it, not seq 1.
    expect(decodeCommit(await reader.next()).body.seq).toBe(2);
  });

  it("sends a FutureCursor error frame for a cursor ahead of the stream", async () => {
    const host = "fh-future.example";
    const handler = pds(host);
    const { reader } = await subscribe(handler, host, "?cursor=999");
    const frame = await reader.next();
    expect([...frame]).toEqual([
      ...encodeErrorFrame("FutureCursor", "cursor is ahead of the stream"),
    ]);
  });

  it("serializes concurrent writes into an ordered, gap-free stream", async () => {
    const host = "fh-concurrent.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const { reader } = await subscribe(handler, host);

    // Fire several writes at once: the DO write queue must serialize them so the
    // commit chain stays linear (no two reading the same `prev` head).
    const n = 6;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        createRecord(handler, host, token, `r${i}`, `text ${i}`),
      ),
    );

    // Exactly n frames, with strictly increasing seqs 1..n — no gaps, no dupes.
    const seqs: number[] = [];
    for (let i = 0; i < n; i++) {
      seqs.push(decodeCommit(await reader.next()).body.seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);

    // Every record landed; nothing was lost to a forked/overwritten commit.
    const listed = await handler(
      new Request(
        `https://${host}/xrpc/com.atproto.repo.listRecords?collection=app.bsky.feed.post`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
      testEnv,
      ctx,
    );
    expect(
      ((await listed.json()) as { records: unknown[] }).records,
    ).toHaveLength(n);
  });

  it("rejects a non-integer cursor with an InvalidRequest error frame", async () => {
    const host = "fh-badcursor.example";
    const handler = pds(host);
    const { reader } = await subscribe(handler, host, "?cursor=1abc");
    const frame = await reader.next();
    expect([...frame]).toEqual([
      ...encodeErrorFrame(
        "InvalidRequest",
        "cursor must be a non-negative integer",
      ),
    ]);
  });

  it("updates the handle and emits an #identity event", async () => {
    const host = "fh-identity.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const { reader } = await subscribe(handler, host);

    const updateHandle = (handle: unknown) =>
      handler(
        new Request(`https://${host}/xrpc/com.atproto.identity.updateHandle`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ handle }),
        }),
        testEnv,
        ctx,
      );

    // A non-string handle is a clean 400, not a 500 (no frame emitted).
    expect((await updateHandle(123)).status).toBe(400);

    const res = await updateHandle("alias.example");
    expect(res.status).toBe(200);

    const idHeader = encodeFrameHeader("#identity");
    const frame = await reader.next();
    expect(decodeCbor(frame.slice(0, idHeader.length))).toEqual({
      op: 1,
      t: "#identity",
    });
    const body = decodeCbor(frame.slice(idHeader.length)) as {
      seq: number;
      did: string;
      handle: string;
    };
    expect(body.seq).toBe(1);
    expect(body.did).toBe(`did:web:${host}`);
    expect(body.handle).toBe("alias.example");

    // The new handle is now the one that resolves; the old one no longer does.
    const resolve = (handle: string) =>
      handler(
        new Request(
          `https://${host}/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`,
        ),
        testEnv,
        ctx,
      );
    expect((await resolve("alias.example")).status).toBe(200);
    expect((await resolve(host)).status).toBe(400);
  });

  it("emits an #account event on the migration activate/deactivate cutover", async () => {
    const host = "fh-account.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const { reader } = await subscribe(handler, host);

    const setActive = async (active: boolean): Promise<void> => {
      const nsid = active
        ? "com.atproto.server.activateAccount"
        : "com.atproto.server.deactivateAccount";
      const res = await handler(
        new Request(`https://${host}/xrpc/${nsid}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
        testEnv,
        ctx,
      );
      expect(res.status).toBe(200);
    };

    const accountHeader = encodeFrameHeader("#account");
    const decodeAccount = (frame: Uint8Array) => ({
      header: decodeCbor(frame.slice(0, accountHeader.length)) as {
        op: number;
        t: string;
      },
      body: decodeCbor(frame.slice(accountHeader.length)) as {
        seq: number;
        did: string;
        active: boolean;
        status?: string;
      },
    });

    // Deactivate — the old-home side of a cutover.
    await setActive(false);
    const down = decodeAccount(await reader.next());
    expect(down.header).toEqual({ op: 1, t: "#account" });
    expect(down.body.did).toBe(`did:web:${host}`);
    expect(down.body.active).toBe(false);
    expect(down.body.status).toBe("deactivated");

    // Reactivate — active, no status, and the shared seq advances.
    await setActive(true);
    const up = decodeAccount(await reader.next());
    expect(up.body.active).toBe(true);
    expect(up.body.status).toBeUndefined();
    expect(up.body.seq).toBe(down.body.seq + 1);
  });
});
