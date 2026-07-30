import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureGcSchema } from "@dwk/store";
import { PropertyStore } from "@dwk/webdav";

import { INTERNAL_HEADERS, type SolidPodEnv } from "./config.js";
import type { SolidPodObject } from "./pod.js";

/**
 * Durable-Object–level tests that drive {@link SolidPodObject} directly via
 * `runInDurableObject` (à la `@dwk/store`), reaching the consistency authority's
 * internals the stateless front door cannot observe: the transactional orphan
 * outbox / GC drain on copy-on-write displacement and delete, concurrent
 * `If-Match` conflict losers, the forwarded-config edge cases, and the
 * write-path guards (anonymous-write refusal, 411, 405) for `POST`/`PATCH`/
 * `DELETE`. The store-level orphan semantics themselves are covered in
 * `@dwk/store`; here we assert the DO wires them through.
 */

const harness = env as unknown as SolidPodEnv & {
  POD: DurableObjectNamespace<SolidPodObject>;
};

const BASE = "https://pod.test";
const OWNER = "https://owner.example/profile#me";
const TURTLE = "text/turtle";
const OCTET = "application/octet-stream";

/** A fresh, isolated pod Durable Object stub keyed by a random name. */
function freshStub(): DurableObjectStub<SolidPodObject> {
  const id = harness.POD.idFromName(crypto.randomUUID());
  return harness.POD.get(id);
}

interface DoInit {
  readonly webid?: string;
  readonly jti?: string;
  readonly body?: BodyInit;
  /** Mark a streaming body so the request declares `duplex: "half"`. */
  readonly stream?: boolean;
  readonly headers?: Record<string, string>;
  /** Forwarded config object; `null` omits the header entirely. */
  readonly config?: Record<string, unknown> | null;
  /** Override the forwarded-config header with a raw (possibly malformed) string. */
  readonly rawConfig?: string;
}

/** Build an internal DO request, mirroring what the trusted front door sends. */
function buildReq(method: string, path: string, init: DoInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.rawConfig !== undefined) {
    headers.set(INTERNAL_HEADERS.config, init.rawConfig);
  } else if (init.config !== null) {
    headers.set(
      INTERNAL_HEADERS.config,
      JSON.stringify(init.config ?? { owners: [OWNER] }),
    );
  }
  if (init.webid !== undefined) headers.set(INTERNAL_HEADERS.webid, init.webid);
  if (init.jti !== undefined) headers.set(INTERNAL_HEADERS.jti, init.jti);

  const reqInit: RequestInit & { duplex?: "half" } = { method, headers };
  if (init.body !== undefined) {
    reqInit.body = init.body;
    if (init.stream) reqInit.duplex = "half";
  }
  return new Request(`${BASE}${path}`, reqInit);
}

/** Drive one request through the live Durable Object instance. */
function run(
  stub: DurableObjectStub<SolidPodObject>,
  method: string,
  path: string,
  init: DoInit = {},
): Promise<Response> {
  return runInDurableObject(stub, (instance) =>
    instance.fetch(buildReq(method, path, init)),
  );
}

/** A single-chunk stream of `text`, for bodies with no `Content-Length`. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Current row count in the shared GC tracking table. */
async function orphanCount(): Promise<number> {
  const row = await harness
    .GC_DB!.prepare("SELECT COUNT(*) AS n FROM orphan_blobs")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Write an opaque blob as the owner; returns the response. */
function putBlob(
  stub: DurableObjectStub<SolidPodObject>,
  path: string,
  body: string,
): Promise<Response> {
  return run(stub, "PUT", path, {
    webid: OWNER,
    jti: crypto.randomUUID(),
    body,
    headers: { "content-type": OCTET, "content-length": String(body.length) },
  });
}

beforeEach(async () => {
  await ensureGcSchema(harness.GC_DB!);
});

describe("@dwk/solid-pod DO orphan outbox → GC drain", () => {
  it("forwards a displaced blob key to the GC table on copy-on-write PUT", async () => {
    const stub = freshStub();
    const path = "/cow.bin";

    expect((await putBlob(stub, path, "version-one")).status).toBe(201);

    const before = await orphanCount();
    // A differing body is a new content-addressed key; the old one is displaced,
    // outboxed inside the write transaction, then drained to the GC table.
    const overwrite = await putBlob(stub, path, "version-two-different");
    expect(overwrite.status).toBe(204);
    expect(await orphanCount()).toBeGreaterThan(before);
  });

  it("forwards a deleted blob key to the GC table", async () => {
    const stub = freshStub();
    const path = "/doomed.bin";
    expect((await putBlob(stub, path, "to-be-deleted")).status).toBe(201);

    const before = await orphanCount();
    const del = await run(stub, "DELETE", path, {
      webid: OWNER,
      jti: crypto.randomUUID(),
    });
    expect(del.status).toBe(204);
    expect(await orphanCount()).toBeGreaterThan(before);
  });
});

describe("@dwk/solid-pod DO If-Match conflict loser", () => {
  it("rejects the losing writer once the winner has advanced the ETag (412)", async () => {
    const stub = freshStub();
    const created = await run(stub, "PUT", "/race", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#1> .",
      headers: { "content-type": TURTLE },
    });
    const etag = created.headers.get("etag");
    expect(etag).toBeTruthy();

    // Both writers hold `etag`; the first commits and advances it.
    const winner = await run(stub, "PUT", "/race", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#2> .",
      headers: { "content-type": TURTLE, "if-match": etag! },
    });
    expect(winner.status).toBe(204);

    // The loser's now-stale validator fails the in-transaction precondition.
    const loser = await run(stub, "PUT", "/race", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#3> .",
      headers: { "content-type": TURTLE, "if-match": etag! },
    });
    expect(loser.status).toBe(412);
  });
});

describe("@dwk/solid-pod DO forwarded-config edge cases", () => {
  it("defaults the config when the header is absent", async () => {
    const stub = freshStub();
    const res = await run(stub, "OPTIONS", "/x", { config: null });
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toContain("PUT");
  });

  it("ignores a malformed forwarded-config header", async () => {
    const stub = freshStub();
    const res = await run(stub, "OPTIONS", "/x", {
      rawConfig: "{not valid json",
    });
    expect(res.status).toBe(204);
  });
});

describe("@dwk/solid-pod DO method + body handling", () => {
  it("rejects an unsupported method with 405", async () => {
    const stub = freshStub();
    const res = await run(stub, "TRACE", "/x", { webid: OWNER });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("serves a HEAD on a blob without streaming its body", async () => {
    const stub = freshStub();
    expect((await putBlob(stub, "/h.bin", "blobbytes")).status).toBe(201);

    const head = await run(stub, "HEAD", "/h.bin", { webid: OWNER });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("9");
    // A HEAD carries no body even though the metadata advertises the length.
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("sets X-Content-Type-Options: nosniff on a served blob", async () => {
    const stub = freshStub();
    expect((await putBlob(stub, "/n.bin", "blobbytes")).status).toBe(201);

    const res = await run(stub, "GET", "/n.bin", { webid: OWNER });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts a bodyless PUT as an empty resource", async () => {
    const stub = freshStub();
    const res = await run(stub, "PUT", "/empty", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      headers: { "content-type": OCTET },
    });
    expect(res.status).toBe(201);
  });

  it("returns 411 when an unsized body overflows the inline ceiling", async () => {
    const stub = freshStub();
    // A streaming body carries no Content-Length; oversized, it can be neither
    // buffered (cell ceiling) nor streamed (needs a declared length) → 411.
    const res = await run(stub, "PUT", "/big", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: streamOf("x".repeat(64)),
      stream: true,
      config: { owners: [OWNER], maxInlineBytes: 8 },
      headers: { "content-type": OCTET },
    });
    expect(res.status).toBe(411);
  });

  it("treats a malformed Content-Length as undeclared and still writes a small body", async () => {
    const stub = freshStub();
    const res = await run(stub, "PUT", "/cl", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: streamOf("tiny"),
      stream: true,
      headers: { "content-type": OCTET, "content-length": "not-a-number" },
    });
    expect(res.status).toBe(201);
  });

  it("honors If-None-Match: * on a read with a 304", async () => {
    const stub = freshStub();
    await run(stub, "PUT", "/cond", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const res = await run(stub, "GET", "/cond", {
      webid: OWNER,
      headers: { "if-none-match": "*" },
    });
    expect(res.status).toBe(304);
  });
});

describe("@dwk/solid-pod DO POST handling", () => {
  it("rejects a POST whose target is not a container (405)", async () => {
    const stub = freshStub();
    const res = await run(stub, "POST", "/not-a-container", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(res.status).toBe(405);
  });

  it("assigns a fresh name when a Slug collides with an existing child", async () => {
    const stub = freshStub();
    const first = await run(stub, "POST", "/c/", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE, slug: "dup" },
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toContain("/c/dup");

    const second = await run(stub, "POST", "/c/", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#d> <#e> <#f> .",
      headers: { "content-type": TURTLE, slug: "dup" },
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("location")).not.toBe(
      first.headers.get("location"),
    );
  });

  it("creates a child container when the Link header marks it as one", async () => {
    const stub = freshStub();
    // A parameter whose quoted value contains a ';' exercises the quote-aware
    // link-parameter splitter alongside the container-type detection.
    const res = await run(stub, "POST", "/c/", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#c> .",
      headers: {
        "content-type": TURTLE,
        slug: "sub",
        link: `<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"; title="x; y"`,
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toMatch(/\/c\/sub\/$/);
  });

  it("ignores a Link header that does not pair a container type with rel=type", async () => {
    const stub = freshStub();
    const res = await run(stub, "POST", "/c/", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: "<#a> <#b> <#c> .",
      headers: {
        "content-type": TURTLE,
        slug: "plain",
        // Container URI but the wrong rel, plus a malformed (bracket-less) entry.
        link: `<http://www.w3.org/ns/ldp#Container>; rel="describedby", not-a-link-entry`,
      },
    });
    expect(res.status).toBe(201);
    // Not promoted to a container: the minted key has no trailing slash.
    expect(res.headers.get("location")).not.toMatch(/\/$/);
  });
});

describe("@dwk/solid-pod DO anonymous-write guard (proof-less writes)", () => {
  it("refuses a POST that carries no DPoP jti", async () => {
    const stub = freshStub();
    const res = await run(stub, "POST", "/c/", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("refuses a PATCH that carries no DPoP jti", async () => {
    const stub = freshStub();
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:inserts { <https://x/me> ex:note "x" . } .`;
    const res = await run(stub, "PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": "text/n3" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a DELETE that carries no DPoP jti", async () => {
    const stub = freshStub();
    const res = await run(stub, "DELETE", "/whatever", { webid: OWNER });
    expect(res.status).toBe(401);
  });

  it("permits a proof-less write when the deployment opts in", async () => {
    const stub = freshStub();
    const res = await run(stub, "PUT", "/anon", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      config: { owners: [OWNER], allowAnonymousWrites: true },
      headers: { "content-type": TURTLE },
    });
    expect(res.status).toBe(201);
  });
});

describe("@dwk/solid-pod DO PATCH + DELETE error paths", () => {
  it("returns 412 when a PATCH If-Match precondition fails", async () => {
    const stub = freshStub();
    await run(stub, "PUT", "/card", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: `<https://x/me> <http://example.org/name> "Old" .`,
      headers: { "content-type": TURTLE },
    });

    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:inserts { <https://x/me> ex:note "x" . } .`;
    const res = await run(stub, "PATCH", "/card", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: patch,
      headers: { "content-type": "text/n3", "if-match": '"stale"' },
    });
    expect(res.status).toBe(412);
  });

  it("returns 400 when a PATCH where pattern is too complex (DoS guard)", async () => {
    const stub = freshStub();
    const where = Array.from(
      { length: 26 },
      (_, n) => `<https://x/s${n}> ex:p "v${n}" .`,
    ).join("\n    ");
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where { ${where} } ;
  solid:inserts { <https://x/me> ex:note "x" . } .`;
    const res = await run(stub, "PATCH", "/card", {
      webid: OWNER,
      jti: crypto.randomUUID(),
      body: patch,
      headers: { "content-type": "text/n3" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 deleting a resource that does not exist", async () => {
    const stub = freshStub();
    const res = await run(stub, "DELETE", "/nope", {
      webid: OWNER,
      jti: crypto.randomUUID(),
    });
    expect(res.status).toBe(404);
  });
});

describe("@dwk/solid-pod DO Solid-door DELETE × WebDAV dead properties", () => {
  it("drops the resource's dead-property rows on an LDP DELETE", async () => {
    const stub = freshStub();
    expect((await putBlob(stub, "/noted.bin", "x")).status).toBe(201);

    // Seed a dead property exactly as the WebDAV door would — same DO SQLite,
    // same table the PROPPATCH path writes.
    await runInDurableObject(stub, (_instance, state) => {
      new PropertyStore(state.storage.sql).set("/noted.bin", {
        ns: "urn:example",
        local: "flavor",
        valueXml: "plum",
      });
    });

    // Delete via the *Solid LDP* door (not the WebDAV router): the dead
    // properties must die with the resource, or a later same-path PUT from
    // either door would resurrect them.
    const del = await run(stub, "DELETE", "/noted.bin", {
      webid: OWNER,
      jti: crypto.randomUUID(),
    });
    expect(del.status).toBe(204);

    const remaining = await runInDurableObject(stub, (_instance, state) =>
      new PropertyStore(state.storage.sql).list("/noted.bin"),
    );
    expect(remaining).toEqual([]);
  });
});
