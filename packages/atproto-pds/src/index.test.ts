import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { base58btcDecode } from "./bytes.js";
import { readCar, writeCar, type CarBlock } from "./car.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { createRepoKeypair, loadSigner, publicKeyMultibase } from "./crypto.js";
import { buildMst, type MstEntry } from "./mst.js";
import { plcRetryDelayMs } from "./object.js";
import { jsonToCbor, recordPath, type JsonValue } from "./record.js";
import { formatCommit, verifyCommit, type SignedCommit } from "./repo.js";
import { TidClock } from "./tid.js";
import { createAtprotoPds, type AtprotoPdsEnv } from "./index.js";

/**
 * End-to-end tests over the real PDS front door + per-account repository Durable
 * Object: identity documents, session auth, the `com.atproto.repo.*` record
 * lifecycle, blob upload/serve, and a CAR repository export whose root commit
 * verifies against the account's published signing key.
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

function pdsK256(host: string) {
  return createAtprotoPds({
    baseUrl: `https://${host}`,
    password: PASSWORD,
    jwtSecret: SECRET,
    signingCurve: "secp256k1",
  });
}

interface CallOptions {
  method?: string;
  body?: unknown;
  raw?: Uint8Array;
  token?: string;
  contentType?: string;
}

async function call(
  handler: ReturnType<typeof pds>,
  host: string,
  path: string,
  opts: CallOptions = {},
): Promise<Response> {
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  let body: BodyInit | undefined;
  if (opts.raw) {
    body = opts.raw as BufferSource;
    headers.set("content-type", opts.contentType ?? "application/octet-stream");
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("content-type", "application/json");
  }
  const request = new Request(`https://${host}${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? "POST" : "GET"),
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  return handler(request, testEnv, ctx);
}

/**
 * A request body stream with no declared length whose reads/cancellation are
 * observable, so a test can assert a capped read aborts partway through
 * instead of buffering the whole body — the gap the streaming rewrite closes
 * for `#uploadBlob` / `#importRepo` (a missing or understated
 * `Content-Length` must not let a client force full buffering).
 */
function trackedStream(
  chunkBytes: number,
  chunkCount: number,
): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
} {
  let pulls = 0;
  let cancelled = false;
  let emitted = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunkCount) {
        controller.close();
        return;
      }
      pulls++;
      emitted++;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

async function login(
  handler: ReturnType<typeof pds>,
  host: string,
): Promise<string> {
  const res = await call(
    handler,
    host,
    "/xrpc/com.atproto.server.createSession",
    {
      body: { identifier: host, password: PASSWORD },
    },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { accessJwt: string }).accessJwt;
}

describe("AT Protocol PDS", () => {
  it("serves the handle → DID binding at /.well-known/atproto-did", async () => {
    const host = "did-binding.example";
    const res = await call(pds(host), host, "/.well-known/atproto-did");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`did:web:${host}`);
  });

  it("serves a DID document with the signing key and PDS service", async () => {
    const host = "did-doc.example";
    const res = await call(pds(host), host, "/.well-known/did.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      id: string;
      verificationMethod: { type: string; publicKeyMultibase: string }[];
      service: { type: string; serviceEndpoint: string }[];
    };
    expect(doc.id).toBe(`did:web:${host}`);
    expect(doc.verificationMethod[0]!.type).toBe("Multikey");
    expect(
      doc.verificationMethod[0]!.publicKeyMultibase.startsWith("zDn"),
    ).toBe(true);
    expect(doc.service[0]!.type).toBe("AtprotoPersonalDataServer");
    expect(doc.service[0]!.serviceEndpoint).toBe(`https://${host}`);
  });

  it("authenticates with the account password and rejects bad ones", async () => {
    const host = "session.example";
    const handler = pds(host);
    const ok = await call(
      handler,
      host,
      "/xrpc/com.atproto.server.createSession",
      {
        body: { identifier: host, password: PASSWORD },
      },
    );
    expect(ok.status).toBe(200);
    const bad = await call(
      handler,
      host,
      "/xrpc/com.atproto.server.createSession",
      {
        body: { identifier: host, password: "wrong" },
      },
    );
    expect(bad.status).toBe(401);
  });

  it("rejects an oversized createSession body with no Content-Length by aborting the stream, not buffering it first", async () => {
    // createSession is the login endpoint — reachable with **no**
    // authentication at all, unlike uploadBlob/importRepo which at least run
    // #requireAuth first. It's the most severe instance of the "buffer
    // first, check later" gap: any anonymous caller could otherwise force an
    // unbounded buffer here.
    const host = "streamed-bigsession.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      maxJsonBodyBytes: 10,
    });
    // 5 chunks of 10 bytes (50 total) against a 10-byte cap, no auth token,
    // no Content-Length header.
    const tracked = trackedStream(10, 5);
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const request = new Request(
      `https://${host}/xrpc/com.atproto.server.createSession`,
      {
        method: "POST",
        headers,
        body: tracked.stream as unknown as BodyInit,
      },
    );
    expect(request.headers.get("content-length")).toBe(null);
    const res = await handler(request, testEnv, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "RequestTooLarge",
    });
    expect(tracked.pulls()).toBeLessThan(5);
    expect(tracked.cancelled()).toBe(true);
  });

  it("refuses record writes without a valid session", async () => {
    const host = "noauth.example";
    const res = await call(
      pds(host),
      host,
      "/xrpc/com.atproto.repo.createRecord",
      {
        body: { collection: "app.bsky.feed.post", record: { text: "hi" } },
      },
    );
    expect(res.status).toBe(401);
  });

  it("runs the create/get/list/put/delete record lifecycle", async () => {
    const host = "records.example";
    const handler = pds(host);
    const token = await login(handler, host);

    const created = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.createRecord",
      {
        body: {
          collection: "app.bsky.feed.post",
          rkey: "first",
          record: { $type: "app.bsky.feed.post", text: "hello atproto" },
        },
        token,
      },
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { uri: string; cid: string };
    expect(createdBody.uri).toBe(
      `at://did:web:${host}/app.bsky.feed.post/first`,
    );

    const got = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.getRecord?collection=app.bsky.feed.post&rkey=first",
      { token },
    );
    expect(got.status).toBe(200);
    expect((await got.json()) as { value: { text: string } }).toMatchObject({
      value: { text: "hello atproto" },
    });

    // A second record, then a collection listing.
    await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
      body: {
        collection: "app.bsky.feed.post",
        rkey: "second",
        record: { $type: "app.bsky.feed.post", text: "another" },
      },
      token,
    });
    const listed = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.listRecords?collection=app.bsky.feed.post",
      { token },
    );
    const listedBody = (await listed.json()) as { records: { uri: string }[] };
    expect(listedBody.records.length).toBe(2);

    // putRecord overwrites.
    await call(handler, host, "/xrpc/com.atproto.repo.putRecord", {
      body: {
        collection: "app.bsky.feed.post",
        rkey: "first",
        record: { $type: "app.bsky.feed.post", text: "edited" },
      },
      token,
    });
    const afterPut = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.getRecord?collection=app.bsky.feed.post&rkey=first",
      { token },
    );
    expect(
      (await afterPut.json()) as { value: { text: string } },
    ).toMatchObject({
      value: { text: "edited" },
    });

    // deleteRecord removes it.
    await call(handler, host, "/xrpc/com.atproto.repo.deleteRecord", {
      body: { collection: "app.bsky.feed.post", rkey: "second" },
      token,
    });
    const afterDelete = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.listRecords?collection=app.bsky.feed.post",
      { token },
    );
    expect(
      ((await afterDelete.json()) as { records: unknown[] }).records.length,
    ).toBe(1);
  });

  it("lists records in reverse rkey order when reverse=true", async () => {
    const host = "reverse.example";
    const handler = pds(host);
    const token = await login(handler, host);
    for (const rkey of ["aaa", "bbb", "ccc"]) {
      await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
        body: {
          collection: "app.bsky.feed.post",
          rkey,
          record: { $type: "app.bsky.feed.post", text: rkey },
        },
        token,
      });
    }
    const rkeys = async (query: string): Promise<(string | undefined)[]> => {
      const res = await call(
        handler,
        host,
        `/xrpc/com.atproto.repo.listRecords?collection=app.bsky.feed.post${query}`,
        { token },
      );
      const body = (await res.json()) as { records: { uri: string }[] };
      return body.records.map((r) => r.uri.split("/").pop());
    };
    expect(await rkeys("")).toEqual(["aaa", "bbb", "ccc"]);
    expect(await rkeys("&reverse=true")).toEqual(["ccc", "bbb", "aaa"]);
    // An empty cursor must behave like no cursor (not `rkey < ''` → []).
    expect(await rkeys("&reverse=true&cursor=")).toEqual(["ccc", "bbb", "aaa"]);
  });

  it("uploads and serves a blob addressed by its raw CID", async () => {
    const host = "blobs.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const uploaded = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.uploadBlob",
      {
        raw: bytes,
        contentType: "image/png",
        token,
      },
    );
    expect(uploaded.status).toBe(200);
    const blob = (await uploaded.json()) as {
      blob: {
        $type: string;
        ref: { $link: string };
        mimeType: string;
        size: number;
      };
    };
    expect(blob.blob.$type).toBe("blob");
    expect(blob.blob.size).toBe(5);
    expect(blob.blob.mimeType).toBe("image/png");

    const fetched = await call(
      handler,
      host,
      `/xrpc/com.atproto.sync.getBlob?cid=${blob.blob.ref.$link}`,
    );
    expect(fetched.status).toBe(200);
    // A known media type is served inline with its type, and never sniffed.
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([
      ...bytes,
    ]);
  });

  it("serves a text/html blob as a non-executable download (stored-XSS guard)", async () => {
    const host = "htmlblob.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
    });
    const token = await login(handler, host);
    const uploaded = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.uploadBlob",
      {
        raw: new TextEncoder().encode("<script>alert(1)</script>"),
        contentType: "text/html",
        token,
      },
    );
    expect(uploaded.status).toBe(200);
    const blob = (await uploaded.json()) as {
      blob: { ref: { $link: string } };
    };
    const fetched = await call(
      handler,
      host,
      `/xrpc/com.atproto.sync.getBlob?cid=${blob.blob.ref.$link}`,
    );
    expect(fetched.status).toBe(200);
    // Not served as HTML: forced to an opaque download, never sniffed.
    expect(fetched.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(fetched.headers.get("content-disposition")).toBe("attachment");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects an oversized blob by its declared Content-Length", async () => {
    const host = "bigblob.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      maxBlobSizeBytes: 4,
    });
    const token = await login(handler, host);
    const res = await call(handler, host, "/xrpc/com.atproto.repo.uploadBlob", {
      raw: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      contentType: "application/octet-stream",
      token,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "BlobTooLarge",
    });
  });

  it("rejects an oversized blob with no Content-Length by aborting the stream, not buffering it first", async () => {
    const host = "streamed-bigblob.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      maxBlobSizeBytes: 10,
    });
    const token = await login(handler, host);
    // 5 chunks of 10 bytes (50 total) against a 10-byte cap, with no
    // Content-Length header at all — the declared-length fast path cannot
    // help here, so only an incremental capped read protects memory.
    const tracked = trackedStream(10, 5);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/octet-stream");
    const request = new Request(
      `https://${host}/xrpc/com.atproto.repo.uploadBlob`,
      {
        method: "POST",
        headers,
        body: tracked.stream as unknown as BodyInit,
      },
    );
    expect(request.headers.get("content-length")).toBe(null);
    const res = await handler(request, testEnv, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "BlobTooLarge",
    });
    // The gap: buffering the whole body via `request.arrayBuffer()` first
    // would drain all 5 chunks before ever checking the size. A correct
    // capped read must cancel the reader as soon as the running total
    // exceeds the cap, well before the stream is fully drained.
    expect(tracked.pulls()).toBeLessThan(5);
    expect(tracked.cancelled()).toBe(true);
  });

  it("reassembles a multi-chunk streamed blob upload byte-for-byte", async () => {
    // Distinct, non-repeating chunk contents, across three separate
    // `resize()` calls on `readRequestBodyCapped`'s resizable backing
    // buffer, so an offset-tracking bug (writing a chunk at the wrong
    // offset, or the length-tracking view ending up the wrong size after the
    // final resize) would corrupt the reassembled bytes — or produce a
    // wrong-length blob — rather than passing by coincidence.
    const host = "multichunk-blob.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5, 6, 7]);
    const chunk3 = new Uint8Array([8]);
    const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const parts = [chunk1, chunk2, chunk3];
        if (step >= parts.length) {
          controller.close();
          return;
        }
        controller.enqueue(parts[step]!);
        step++;
      },
    });
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/octet-stream");
    const request = new Request(
      `https://${host}/xrpc/com.atproto.repo.uploadBlob`,
      { method: "POST", headers, body: stream as unknown as BodyInit },
    );
    const res = await handler(request, testEnv, ctx);
    expect(res.status).toBe(200);
    const uploaded = (await res.json()) as {
      blob: { ref: { $link: string }; size: number };
    };
    expect(uploaded.blob.size).toBe(expected.length);
    const fetched = await call(
      handler,
      host,
      `/xrpc/com.atproto.sync.getBlob?cid=${uploaded.blob.ref.$link}`,
    );
    const fetchedBytes = new Uint8Array(await fetched.arrayBuffer());
    expect(fetchedBytes).toEqual(expected);
  });

  it("resolves its own handle and describes the repo", async () => {
    const host = "resolve.example";
    const handler = pds(host);
    const resolved = await call(
      handler,
      host,
      `/xrpc/com.atproto.identity.resolveHandle?handle=${host}`,
    );
    expect((await resolved.json()) as { did: string }).toEqual({
      did: `did:web:${host}`,
    });

    const described = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.describeRepo?repo=" + host,
    );
    expect((await described.json()) as { handle: string }).toMatchObject({
      handle: host,
      did: `did:web:${host}`,
    });
  });

  it("exports a CAR whose root commit verifies against the published key", async () => {
    const host = "carexport.example";
    const handler = pds(host);
    const token = await login(handler, host);
    await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
      body: {
        collection: "app.bsky.feed.post",
        rkey: "x",
        record: { $type: "app.bsky.feed.post", text: "in the car" },
      },
      token,
    });

    // The DID document publishes the repository signing key.
    const didDoc = (await (
      await call(handler, host, "/.well-known/did.json")
    ).json()) as { verificationMethod: { publicKeyMultibase: string }[] };
    const pubMultibase = didDoc.verificationMethod[0]!.publicKeyMultibase;

    const head = (await (
      await call(handler, host, "/xrpc/com.atproto.sync.getLatestCommit")
    ).json()) as { cid: string; rev: string };

    const carRes = await call(
      handler,
      host,
      "/xrpc/com.atproto.sync.getRepo?did=" + host,
    );
    expect(carRes.headers.get("content-type")).toBe("application/vnd.ipld.car");
    const car = readCar(new Uint8Array(await carRes.arrayBuffer()));

    // The CAR's declared root is the latest commit.
    expect(car.roots[0]!.toString()).toBe(head.cid);

    // Find the commit block, decode it, and verify its signature against the
    // public key from the DID document — the repository is self-verifying and
    // portable, exactly the property that makes hosting swappable.
    const rootBlock = car.blocks.find((b) => b.cid.equals(car.roots[0]!))!;
    const commit = decodeCbor(rootBlock.bytes) as unknown as SignedCommit;
    expect(commit.did).toBe(`did:web:${host}`);
    expect(commit.version).toBe(3);

    const raw = decompressP256(pubMultibase);
    expect(await verifyCommit(commit, raw)).toBe(true);

    // Every block the commit references is present in the CAR (self-contained).
    expect(car.blocks.some((b) => b.cid.equals(commit.data))).toBe(true);
  });

  it("streams a multi-record getRepo export as a real ReadableStream, containing every record", async () => {
    const host = "carstream.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const rkeys = ["a", "b", "c", "d", "e"];
    for (const rkey of rkeys) {
      await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
        body: {
          collection: "app.bsky.feed.post",
          rkey,
          record: { $type: "app.bsky.feed.post", text: `post ${rkey}` },
        },
        token,
      });
    }

    const carRes = await call(
      handler,
      host,
      "/xrpc/com.atproto.sync.getRepo?did=" + host,
    );
    // The response body is a stream, not a pre-buffered `BodyInit`.
    expect(carRes.body).toBeInstanceOf(ReadableStream);

    const car = readCar(new Uint8Array(await carRes.arrayBuffer()));
    const head = (await (
      await call(handler, host, "/xrpc/com.atproto.sync.getLatestCommit")
    ).json()) as { cid: string };
    expect(car.roots[0]!.toString()).toBe(head.cid);

    // Every record's block is present, self-contained, and byte-correct.
    for (const rkey of rkeys) {
      const record = encodeCbor(
        jsonToCbor({
          $type: "app.bsky.feed.post",
          text: `post ${rkey}`,
        } as JsonValue),
      );
      const cid = await CID.create(DAG_CBOR_CODEC, record);
      const found = car.blocks.find((b) => b.cid.equals(cid));
      expect(found).toBeDefined();
      expect([...found!.bytes]).toEqual([...record]);
    }
  });

  it("signs commits with secp256k1 when configured, advertising a k-256 key", async () => {
    const host = "k256.example";
    const handler = pdsK256(host);
    const token = await login(handler, host);
    await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
      body: {
        collection: "app.bsky.feed.post",
        rkey: "x",
        record: { $type: "app.bsky.feed.post", text: "signed with k-256" },
      },
      token,
    });

    // The published key is a secp256k1 Multikey (`zQ3sh…`), not a P-256 one.
    const didDoc = (await (
      await call(handler, host, "/.well-known/did.json")
    ).json()) as { verificationMethod: { publicKeyMultibase: string }[] };
    const pubMultibase = didDoc.verificationMethod[0]!.publicKeyMultibase;
    expect(pubMultibase.startsWith("zQ3sh")).toBe(true);

    // The root commit verifies under the secp256k1 curve against the published
    // key. The compressed key (multicodec 0xe7 0x01 prefix stripped) is accepted
    // by the verifier directly.
    const carRes = await call(
      handler,
      host,
      "/xrpc/com.atproto.sync.getRepo?did=" + host,
    );
    const car = readCar(new Uint8Array(await carRes.arrayBuffer()));
    const rootBlock = car.blocks.find((b) => b.cid.equals(car.roots[0]!))!;
    const commit = decodeCbor(rootBlock.bytes) as unknown as SignedCommit;
    const compressed = base58btcDecode(pubMultibase.slice(1)).slice(2);
    expect(await verifyCommit(commit, compressed, "secp256k1")).toBe(true);
  });

  it("mints a did:plc account and serves the derived DID consistently", async () => {
    const host = "plc-account.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      didMethod: "plc",
    });

    // The handle → DID binding is the DO-derived did:plc, not a did:web.
    const did = await (
      await call(handler, host, "/.well-known/atproto-did")
    ).text();
    expect(did).toMatch(/^did:plc:[a-z2-7]{24}$/);

    // A did:plc account's document lives in the PLC directory, not at the origin.
    expect((await call(handler, host, "/.well-known/did.json")).status).toBe(
      404,
    );

    // Sessions and repo description report the same did:plc.
    const token = await login(handler, host);
    const session = (await (
      await call(handler, host, "/xrpc/com.atproto.server.getSession", {
        token,
      })
    ).json()) as { did: string };
    expect(session.did).toBe(did);
    const described = (await (
      await call(
        handler,
        host,
        "/xrpc/com.atproto.repo.describeRepo?repo=" + host,
      )
    ).json()) as { did: string };
    expect(described.did).toBe(did);

    // Commits are signed under the did:plc, so the exported repo is self-consistent.
    await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
      body: {
        collection: "app.bsky.feed.post",
        rkey: "x",
        record: { $type: "app.bsky.feed.post", text: "hello plc" },
      },
      token,
    });
    const car = readCar(
      new Uint8Array(
        await (
          await call(
            handler,
            host,
            "/xrpc/com.atproto.sync.getRepo?did=" + host,
          )
        ).arrayBuffer(),
      ),
    );
    const rootBlock = car.blocks.find((b) => b.cid.equals(car.roots[0]!))!;
    const commit = decodeCbor(rootBlock.bytes) as unknown as SignedCommit;
    expect(commit.did).toBe(did);
  });

  it("submits the genesis op to the PLC directory when one is configured", async () => {
    const seen: { url: string; method?: string; body?: string }[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("plc.test")) {
        seen.push({ url, method: init?.method, body: init?.body as string });
        return new Response(null, { status: 200 });
      }
      return realFetch(input as RequestInfo, init);
    });

    const host = "plc-submit.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      didMethod: "plc",
      plcDirectoryUrl: "https://plc.test",
    });
    // First request triggers genesis; submission runs in the background via
    // waitUntil, so poll for it rather than asserting synchronously.
    const did = await (
      await call(handler, host, "/.well-known/atproto-did")
    ).text();

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.url).toBe(`https://plc.test/${did}`);
    expect(seen[0]!.method).toBe("POST");
    const op = JSON.parse(seen[0]!.body as string) as {
      type: string;
      alsoKnownAs: string[];
    };
    expect(op.type).toBe("plc_operation");
    expect(op.alsoKnownAs).toContain(`at://${host}`);
  });

  it("retries via the alarm when the directory rejects the genesis op", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("plc.fail"))
        return new Response("down", { status: 503 });
      return realFetch(input as RequestInfo, init);
    });

    const host = "plc-retry.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      didMethod: "plc",
      plcDirectoryUrl: "https://plc.fail",
    });
    await call(handler, host, "/.well-known/atproto-did");

    const stub = testEnv.REPO.get(testEnv.REPO.idFromName(host));
    // The first alarm fires, the submission fails, and the DO records the failed
    // attempt and re-arms a future alarm rather than giving up.
    await vi.waitFor(async () => {
      const attempts = await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql
          .exec("SELECT v FROM kv WHERE k = 'plc_attempts'")
          .toArray()[0] as { v: string } | undefined;
        return row?.v ?? null;
      });
      expect(attempts).toBe("1");
    });
    const [submitted, alarm] = await runInDurableObject(
      stub,
      async (_instance, state) => {
        const row = state.storage.sql
          .exec("SELECT v FROM kv WHERE k = 'plc_submitted'")
          .toArray()[0] as { v: string } | undefined;
        return [row?.v ?? null, await state.storage.getAlarm()] as const;
      },
    );
    expect(submitted).toBeNull(); // not marked submitted after a failure
    expect(typeof alarm).toBe("number");
    expect(alarm as number).toBeGreaterThan(Date.now());
  });

  it("plcRetryDelayMs backs off exponentially with a cap", () => {
    expect(plcRetryDelayMs(1)).toBe(10_000);
    expect(plcRetryDelayMs(2)).toBe(20_000);
    expect(plcRetryDelayMs(3)).toBe(40_000);
    expect(plcRetryDelayMs(50)).toBe(3_600_000); // capped at 1h
  });

  it("toggles account status for the migration cutover", async () => {
    const host = "status.example";
    const handler = pds(host);
    const token = await login(handler, host);

    const status = async () =>
      (await (
        await call(
          handler,
          host,
          `/xrpc/com.atproto.sync.getRepoStatus?did=did:web:${host}`,
        )
      ).json()) as { active: boolean; status?: string };

    // Active by default.
    expect(await status()).toMatchObject({ active: true });
    expect((await status()).status).toBeUndefined();

    // Deactivate (authenticated).
    const deact = await call(
      handler,
      host,
      "/xrpc/com.atproto.server.deactivateAccount",
      { body: {}, token },
    );
    expect(deact.status).toBe(200);
    expect(await status()).toMatchObject({
      active: false,
      status: "deactivated",
    });

    // checkAccountStatus reflects it.
    const checked = (await (
      await call(handler, host, "/xrpc/com.atproto.server.checkAccountStatus", {
        token,
      })
    ).json()) as { activated: boolean; indexedRecords: number };
    expect(checked.activated).toBe(false);
    expect(typeof checked.indexedRecords).toBe("number");

    // Reactivate.
    await call(handler, host, "/xrpc/com.atproto.server.activateAccount", {
      body: {},
      token,
    });
    expect(await status()).toMatchObject({ active: true });

    // Toggling requires auth.
    const noauth = await call(
      handler,
      host,
      "/xrpc/com.atproto.server.deactivateAccount",
      { body: {} },
    );
    expect(noauth.status).toBe(401);

    // getRepoStatus validates the required `did` param.
    expect(
      (await call(handler, host, "/xrpc/com.atproto.sync.getRepoStatus"))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          handler,
          host,
          "/xrpc/com.atproto.sync.getRepoStatus?did=did:web:someone.else",
        )
      ).status,
    ).toBe(404);
  });

  it("reports held and missing blobs (listBlobs / listMissingBlobs)", async () => {
    const host = "blobs-migration.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const did = `did:web:${host}`;

    // Upload one blob and reference it from a record.
    const up = await call(handler, host, "/xrpc/com.atproto.repo.uploadBlob", {
      raw: new Uint8Array([1, 2, 3, 4, 5]),
      contentType: "image/png",
      token,
    });
    const uploaded = (await up.json()) as {
      blob: { ref: { $link: string } };
    };
    const heldCid = uploaded.blob.ref.$link;
    await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
      body: {
        collection: "app.bsky.actor.profile",
        rkey: "self",
        record: { $type: "app.bsky.actor.profile", avatar: uploaded.blob },
      },
      token,
    });

    // A record referencing a blob we never uploaded.
    const missingCid = (
      await CID.create(DAG_CBOR_CODEC, encodeCbor({ missing: true }))
    ).toString();
    await call(handler, host, "/xrpc/com.atproto.repo.createRecord", {
      body: {
        collection: "app.bsky.feed.post",
        rkey: "p",
        record: {
          $type: "app.bsky.feed.post",
          text: "x",
          embed: {
            $type: "blob",
            ref: { $link: missingCid },
            mimeType: "image/png",
            size: 9,
          },
        },
      },
      token,
    });

    // listBlobs reports the held blob.
    const lb = (await (
      await call(handler, host, `/xrpc/com.atproto.sync.listBlobs?did=${did}`)
    ).json()) as { cids: string[] };
    expect(lb.cids).toContain(heldCid);

    // listMissingBlobs reports the referenced-but-unheld blob, not the held one.
    const lm = (await (
      await call(handler, host, "/xrpc/com.atproto.repo.listMissingBlobs", {
        token,
      })
    ).json()) as { blobs: { cid: string }[] };
    const missingList = lm.blobs.map((b) => b.cid);
    expect(missingList).toContain(missingCid);
    expect(missingList).not.toContain(heldCid);

    // checkAccountStatus blob counts reflect referenced vs held.
    const cs = (await (
      await call(handler, host, "/xrpc/com.atproto.server.checkAccountStatus", {
        token,
      })
    ).json()) as { expectedBlobs: number; importedBlobs: number };
    expect(cs.expectedBlobs).toBe(2);
    expect(cs.importedBlobs).toBe(1);
  });

  it("paginates listBlobs with limit and cursor", async () => {
    const host = "blob-page.example";
    const handler = pds(host);
    const token = await login(handler, host);
    const did = `did:web:${host}`;

    // Upload three distinct blobs.
    for (const n of [1, 2, 3]) {
      await call(handler, host, "/xrpc/com.atproto.repo.uploadBlob", {
        raw: new Uint8Array([n, n, n]),
        contentType: "application/octet-stream",
        token,
      });
    }

    const page1 = (await (
      await call(
        handler,
        host,
        `/xrpc/com.atproto.sync.listBlobs?did=${did}&limit=2`,
      )
    ).json()) as { cids: string[]; cursor?: string };
    expect(page1.cids).toHaveLength(2);
    expect(page1.cursor).toBe(page1.cids[1]);

    const page2 = (await (
      await call(
        handler,
        host,
        `/xrpc/com.atproto.sync.listBlobs?did=${did}&limit=2&cursor=${page1.cursor}`,
      )
    ).json()) as { cids: string[]; cursor?: string };
    expect(page2.cids).toHaveLength(1);
    expect(page2.cursor).toBeUndefined(); // last page
    // No overlap between pages.
    expect(page1.cids).not.toContain(page2.cids[0]);
  });

  it("recommends DID credentials pointing at this PDS", async () => {
    const host = "rotate.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      didMethod: "plc", // minted did:plc → has a DO-custodied rotation key
    });
    const token = await login(handler, host);

    const creds = (await (
      await call(
        handler,
        host,
        "/xrpc/com.atproto.identity.getRecommendedDidCredentials",
        { token },
      )
    ).json()) as {
      rotationKeys: string[];
      alsoKnownAs: string[];
      verificationMethods: { atproto: string };
      services: { atproto_pds: { type: string; endpoint: string } };
    };

    expect(creds.services.atproto_pds.endpoint).toBe(`https://${host}`);
    expect(creds.alsoKnownAs).toContain(`at://${host}`);
    expect(creds.verificationMethods.atproto.startsWith("did:key:z")).toBe(
      true,
    );
    // A minted did:plc account recommends its rotation key (secp256k1 → zQ3sh).
    expect(creds.rotationKeys.length).toBeGreaterThan(0);
    expect(creds.rotationKeys[0]!.startsWith("did:key:zQ3sh")).toBe(true);
  });

  it("imports a repo (importRepo) and re-signs the head onto our key", async () => {
    const did = "did:plc:src234src234src234src234";
    const host = "migrated.example";

    // A source repository, signed by the *source* account's key.
    const source = await createRepoKeypair("secp256k1");
    const sourceSign = await loadSigner(source.curve, source.privateKeyExport);
    const recordValue: JsonValue = {
      $type: "app.bsky.feed.post",
      text: "migrated post",
    };
    const recordBytes = encodeCbor(jsonToCbor(recordValue));
    const recordCid = await CID.create(DAG_CBOR_CODEC, recordBytes);
    const entries: MstEntry[] = [
      { key: recordPath("app.bsky.feed.post", "aaa"), value: recordCid },
    ];
    const mst = await buildMst(entries);
    const carBlocks: CarBlock[] = [{ cid: recordCid, bytes: recordBytes }];
    for (const [cidStr, bytes] of mst.blocks) {
      carBlocks.push({ cid: CID.parse(cidStr), bytes });
    }
    const formatted = await formatCommit(
      {
        did,
        version: 3,
        data: mst.root,
        rev: new TidClock().next(),
        prev: null,
      },
      sourceSign,
    );
    carBlocks.push({ cid: formatted.cid, bytes: formatted.bytes });
    const car = writeCar([formatted.cid], carBlocks);
    const importedHead = formatted.cid.toString();

    // The DID (still pointing at the source pre-cutover) advertises the source key.
    const realFetch = globalThis.fetch;
    const sourceMultibase = publicKeyMultibase(
      source.publicKeyRaw,
      source.curve,
    );
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === `https://plc.test/${did}`) {
        return new Response(
          JSON.stringify({
            id: did,
            verificationMethod: [
              {
                id: `${did}#atproto`,
                type: "Multikey",
                publicKeyMultibase: sourceMultibase,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return realFetch(input as RequestInfo, init);
    });

    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      didMethod: "plc",
      did, // adopt the existing did:plc (migration)
      plcDirectoryUrl: "https://plc.test",
    });
    const token = await login(handler, host);

    const res = await call(handler, host, "/xrpc/com.atproto.repo.importRepo", {
      raw: car,
      contentType: "application/vnd.ipld.car",
      token,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { importedRecords: number }).toMatchObject({
      importedRecords: 1,
    });

    // The imported record is served from our store.
    const got = await call(
      handler,
      host,
      "/xrpc/com.atproto.repo.getRecord?collection=app.bsky.feed.post&rkey=aaa",
      { token },
    );
    expect(((await got.json()) as { value: JsonValue }).value).toMatchObject({
      text: "migrated post",
    });

    // The new head is signed afresh and chains `prev` to the imported head.
    const carRes = await call(
      handler,
      host,
      "/xrpc/com.atproto.sync.getRepo?did=" + host,
    );
    const parsed = readCar(new Uint8Array(await carRes.arrayBuffer()));
    const rootBlock = parsed.blocks.find((b) =>
      b.cid.equals(parsed.roots[0]!),
    )!;
    const commit = decodeCbor(rootBlock.bytes) as unknown as SignedCommit;
    expect(commit.did).toBe(did);
    expect(commit.prev?.toString()).toBe(importedHead);
  });

  it("rejects an oversized migration CAR by declared Content-Length before buffering it", async () => {
    const host = "bigcar.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      maxImportCarSizeBytes: 1024,
    });
    const token = await login(handler, host);
    const oversizedCar = new Uint8Array(2048);
    const res = await call(handler, host, "/xrpc/com.atproto.repo.importRepo", {
      raw: oversizedCar,
      contentType: "application/vnd.ipld.car",
      token,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "CarTooLarge",
    });
  });

  it("rejects an oversized migration CAR with no Content-Length by aborting the stream, not buffering it first", async () => {
    const host = "streamed-bigcar.example";
    const handler = createAtprotoPds({
      baseUrl: `https://${host}`,
      password: PASSWORD,
      jwtSecret: SECRET,
      maxImportCarSizeBytes: 10,
    });
    const token = await login(handler, host);
    const tracked = trackedStream(10, 5);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    headers.set("content-type", "application/vnd.ipld.car");
    const request = new Request(
      `https://${host}/xrpc/com.atproto.repo.importRepo`,
      {
        method: "POST",
        headers,
        body: tracked.stream as unknown as BodyInit,
      },
    );
    expect(request.headers.get("content-length")).toBe(null);
    const res = await handler(request, testEnv, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "CarTooLarge",
    });
    expect(tracked.pulls()).toBeLessThan(5);
    expect(tracked.cancelled()).toBe(true);
  });
});

/**
 * Front-door logging when the DO returns a 500. These stub `env.REPO` rather
 * than routing to the real Durable Object, since the behaviour under test —
 * `forwardToDo` reading the response the DO handed back — doesn't depend on
 * why the DO failed, only on the response shape it failed with.
 */
describe("front-door unhandled-error logging", () => {
  function fakeEnv(fetchImpl: (request: Request) => Promise<Response>) {
    const stub = { fetch: fetchImpl };
    return {
      REPO: {
        idFromName: () => "fake-id",
        get: () => stub,
      },
      BLOBS: {},
    } as unknown as AtprotoPdsEnv;
  }

  it("logs an aggregate event when the DO returns the generic InternalServerError envelope", async () => {
    const logged: Array<[string, unknown]> = [];
    const counted: Array<[string, unknown]> = [];
    const handler = createAtprotoPds({
      baseUrl: "https://logging.example",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (event, fields) => logged.push([event, fields]),
      },
      metrics: {
        count: (event, fields) => counted.push([event, fields]),
        observe: () => {},
      },
    });
    const fakeAtprotoEnv = fakeEnv(
      async () =>
        new Response(
          JSON.stringify({
            error: "InternalServerError",
            message: "Internal server error",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await handler(
      new Request("https://logging.example/xrpc/com.atproto.repo.createRecord"),
      fakeAtprotoEnv,
      ctx,
    );
    // The real caller still gets the full, unconsumed response body.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "InternalServerError",
      message: "Internal server error",
    });
    expect(logged).toContainEqual([
      "atproto_pds.xrpc.internal_error",
      { path: "/xrpc/com.atproto.repo.createRecord" },
    ]);
    expect(counted).toContainEqual([
      "atproto_pds.xrpc.internal_error",
      undefined,
    ]);
  });

  it("logs when the DO 500s before it can even produce the XRPC envelope", async () => {
    const logged: Array<[string, unknown]> = [];
    const handler = createAtprotoPds({
      baseUrl: "https://logging-bypass.example",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (event, fields) => logged.push([event, fields]),
      },
    });
    const fakeAtprotoEnv = fakeEnv(
      async () => new Response("missing internal config", { status: 500 }),
    );
    const res = await handler(
      new Request(
        "https://logging-bypass.example/xrpc/com.atproto.server.getSession",
      ),
      fakeAtprotoEnv,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("missing internal config");
    expect(logged).toContainEqual([
      "atproto_pds.xrpc.internal_error",
      { path: "/xrpc/com.atproto.server.getSession" },
    ]);
  });

  it("does not log a legitimate XRPC error that happens to carry a 500 status", async () => {
    const logged: Array<[string, unknown]> = [];
    const handler = createAtprotoPds({
      baseUrl: "https://logging-legit.example",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (event, fields) => logged.push([event, fields]),
      },
    });
    const fakeAtprotoEnv = fakeEnv(
      async () =>
        new Response(JSON.stringify({ error: "SomeOtherError" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await handler(
      new Request(
        "https://logging-legit.example/xrpc/com.atproto.repo.createRecord",
      ),
      fakeAtprotoEnv,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(logged).toEqual([]);
  });

  it("does not log for a 2xx response", async () => {
    const logged: Array<[string, unknown]> = [];
    const handler = createAtprotoPds({
      baseUrl: "https://logging-ok.example",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (event, fields) => logged.push([event, fields]),
      },
    });
    const fakeAtprotoEnv = fakeEnv(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    const res = await handler(
      new Request(
        "https://logging-ok.example/xrpc/com.atproto.server.getSession",
      ),
      fakeAtprotoEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(logged).toEqual([]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Decode a `zDn…` p256 Multikey back to the raw uncompressed public key. */
function decompressP256(multibase: string): Uint8Array {
  const bytes = base58btcDecode(multibase.slice(1)); // drop 'z'
  const compressed = bytes.slice(2); // drop 0x80 0x24 multicodec prefix
  return uncompress(compressed);
}

// secp256r1 (P-256) curve parameters for point decompression.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = 0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function uncompress(compressed: Uint8Array): Uint8Array {
  const prefix = compressed[0]!;
  let x = 0n;
  for (let i = 1; i < 33; i++) x = (x << 8n) | BigInt(compressed[i]!);
  const rhs = (x * x * x + A * x + B) % P;
  let y = modSqrt(rhs, P);
  const yIsOdd = (y & 1n) === 1n;
  if (yIsOdd !== (prefix === 0x03)) y = P - y;
  const out = new Uint8Array(65);
  out[0] = 0x04;
  for (let i = 31; i >= 0; i--) {
    out[1 + i] = Number(x & 0xffn);
    x >>= 8n;
    out[33 + i] = Number(y & 0xffn);
    y >>= 8n;
  }
  return out;
}

function modSqrt(n: bigint, p: bigint): bigint {
  // p ≡ 3 (mod 4) for P-256, so sqrt = n^((p+1)/4) mod p.
  return modPow(n, (p + 1n) / 4n, p);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}
