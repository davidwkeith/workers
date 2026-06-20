import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { base58btcDecode } from "./bytes";
import { readCar } from "./car";
import { decodeCbor } from "./cbor";
import { verifyCommit, type SignedCommit } from "./repo";
import { createAtprotoPds, type AtprotoPdsEnv } from "./index";

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
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([
      ...bytes,
    ]);
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
