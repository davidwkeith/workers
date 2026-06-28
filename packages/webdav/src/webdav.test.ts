import {
  createExecutionContext,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CollectionNotEmpty,
  PreconditionFailed,
  ResourceConflict,
  resolveLockPolicy,
  type ResourceBody,
  type ResourceStat,
  type WebdavBackend,
  type WebdavMode,
  type WriteOutcome,
  type WritePreconditions,
} from "./config.js";
import { CredentialStore } from "./credential-store.js";
import { LockStore } from "./locks.js";
import { createWebdav } from "./webdav.js";
import type { WebdavTestObject } from "./test-harness.js";

interface HarnessEnv {
  readonly WEBDAV_DO: DurableObjectNamespace<WebdavTestObject>;
}
const harness = env as unknown as HarnessEnv;
const ITER = 1000;
const WEBID = "https://me.example/#me";

interface MemResource {
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: number;
  createdAt: number;
  collection: boolean;
}

async function toBytes(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function parentOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1) || "/";
}

/** An in-memory pod backend over real DO-SQLite lock + credential stores. */
class MemBackend implements WebdavBackend {
  readonly resources = new Map<string, MemResource>();
  readonly locks: LockStore;
  readonly credentials: CredentialStore;
  allow: (webid: string, path: string, mode: WebdavMode) => boolean = () =>
    true;

  constructor(
    sql: SqlStorage,
    private readonly now: () => number,
  ) {
    this.locks = new LockStore(
      sql,
      resolveLockPolicy({ maxInfinityDepth: 3 }),
      "/",
      now,
    );
    this.credentials = new CredentialStore(sql, {}, now);
    this.resources.set("/", {
      body: new Uint8Array(),
      contentType: "text/turtle",
      etag: '"root"',
      lastModified: now(),
      createdAt: now(),
      collection: true,
    });
  }

  #stat(path: string): ResourceStat | null {
    const r = this.resources.get(path);
    if (!r) return null;
    return {
      path,
      collection: r.collection,
      etag: r.etag,
      contentType: r.contentType,
      contentLength: r.collection ? 0 : r.body.byteLength,
      lastModified: r.lastModified,
      createdAt: r.createdAt,
    };
  }

  #check(existing: MemResource | undefined, pre: WritePreconditions): void {
    if (pre.ifMatch !== undefined) {
      if (!existing || (pre.ifMatch !== "*" && existing.etag !== pre.ifMatch)) {
        throw new PreconditionFailed();
      }
    }
    if (pre.ifNoneMatch !== undefined) {
      const hit =
        pre.ifNoneMatch === "*"
          ? existing !== undefined
          : existing !== undefined && existing.etag === pre.ifNoneMatch;
      if (hit) throw new PreconditionFailed();
    }
  }

  async stat(path: string): Promise<ResourceStat | null> {
    return this.#stat(path);
  }

  async listChildren(path: string): Promise<readonly ResourceStat[]> {
    const out: ResourceStat[] = [];
    for (const key of this.resources.keys()) {
      if (key === path || !key.startsWith(path)) continue;
      const rest = key.slice(path.length);
      const trimmed = rest.endsWith("/") ? rest.slice(0, -1) : rest;
      if (!trimmed.includes("/")) {
        const stat = this.#stat(key);
        if (stat) out.push(stat);
      }
    }
    return out;
  }

  async read(path: string): Promise<ResourceBody | null> {
    const r = this.resources.get(path);
    if (!r || r.collection) return null;
    const stat = this.#stat(path);
    if (!stat) return null;
    return {
      stat,
      body: new Response(r.body).body as ReadableStream<Uint8Array>,
    };
  }

  async write(
    path: string,
    body: ReadableStream<Uint8Array> | null,
    contentType: string,
    pre: WritePreconditions,
  ): Promise<WriteOutcome> {
    if (this.resources.get(parentOf(path))?.collection !== true) {
      throw new ResourceConflict("missing parent collection");
    }
    const existing = this.resources.get(path);
    this.#check(existing, pre);
    const etag = `"${crypto.randomUUID()}"`;
    this.resources.set(path, {
      body: await toBytes(body),
      contentType,
      etag,
      lastModified: this.now(),
      createdAt: existing?.createdAt ?? this.now(),
      collection: false,
    });
    return { created: existing === undefined, etag };
  }

  async makeCollection(path: string): Promise<WriteOutcome> {
    if (this.resources.get(parentOf(path))?.collection !== true) {
      throw new ResourceConflict("missing parent collection");
    }
    const etag = `"${crypto.randomUUID()}"`;
    this.resources.set(path, {
      body: new Uint8Array(),
      contentType: "text/turtle",
      etag,
      lastModified: this.now(),
      createdAt: this.now(),
      collection: true,
    });
    return { created: true, etag };
  }

  async remove(path: string, pre: WritePreconditions): Promise<void> {
    const existing = this.resources.get(path);
    this.#check(existing, pre);
    if (existing?.collection) {
      const children = await this.listChildren(path);
      if (children.length > 0) throw new CollectionNotEmpty();
    }
    this.resources.delete(path);
  }

  async copy(
    from: string,
    to: string,
    depth: "0" | "infinity",
    _overwrite: boolean,
  ): Promise<WriteOutcome> {
    const src = this.resources.get(from);
    if (!src) throw new ResourceConflict("missing source");
    if (this.resources.get(parentOf(to))?.collection !== true) {
      throw new ResourceConflict("missing parent collection");
    }
    const created = !this.resources.has(to);
    this.resources.set(to, { ...src, body: src.body.slice() });
    if (src.collection && depth === "infinity") {
      for (const [key, value] of [...this.resources]) {
        if (key !== from && key.startsWith(from)) {
          this.resources.set(to + key.slice(from.length), {
            ...value,
            body: value.body.slice(),
          });
        }
      }
    }
    return { created };
  }

  async move(
    from: string,
    to: string,
    depth: "0" | "infinity",
    overwrite: boolean,
  ): Promise<WriteOutcome> {
    const outcome = await this.copy(from, to, depth, overwrite);
    for (const key of [...this.resources.keys()]) {
      if (key === from || key.startsWith(from)) this.resources.delete(key);
    }
    return outcome;
  }

  async authorize(
    webid: string,
    path: string,
    mode: WebdavMode,
  ): Promise<boolean> {
    return this.allow(webid, path, mode);
  }
}

interface Harness {
  call: (
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: string; auth?: boolean },
  ) => Promise<Response>;
  backend: MemBackend;
}

async function withHandler(
  fn: (h: Harness) => Promise<void>,
  options: { scope?: ("read" | "write")[]; now?: () => number } = {},
): Promise<void> {
  const id = harness.WEBDAV_DO.idFromName(crypto.randomUUID());
  const stub = harness.WEBDAV_DO.get(id);
  await runInDurableObject(stub, async (instance) => {
    const now = options.now ?? (() => 1_000_000);
    const backend = new MemBackend(instance.sql, now);
    const cred = await backend.credentials.mint({
      webid: WEBID,
      label: "Finder",
      scope: { modes: options.scope ?? ["read", "write"] },
      iterations: ITER,
    });
    const basic = `Basic ${btoa(`${cred.username}:${cred.secret}`)}`;
    const handler = createWebdav({
      baseUrl: "https://pod.example",
      backend: () => backend,
      now,
      denyOsLitter: false,
    });
    const call: Harness["call"] = (method, path, init = {}) => {
      const headers: Record<string, string> = { ...init.headers };
      if (init.auth !== false) headers["authorization"] = basic;
      const reqInit: RequestInit = { method, headers };
      if (init.body !== undefined) reqInit.body = init.body;
      return handler(
        new Request(`https://pod.example${path}`, reqInit),
        {} as never,
        createExecutionContext(),
      );
    };
    await fn({ call, backend });
  });
}

describe("createWebdav — OPTIONS & auth (spec §1)", () => {
  it("advertises Class 2 (DAV: 1, 2) on OPTIONS without authentication", async () => {
    await withHandler(async ({ call }) => {
      const res = await call("OPTIONS", "/", { auth: false });
      expect(res.status).toBe(204);
      expect(res.headers.get("DAV")).toBe("1, 2");
      expect(res.headers.get("MS-Author-Via")).toBe("DAV");
      expect(res.headers.get("Allow")).toContain("LOCK");
      expect(res.headers.get("Allow")).not.toContain("DELETE"); // root is undeletable
    });
  });

  it("rejects a non-HTTPS request before parsing credentials", async () => {
    await withHandler(async ({ backend }) => {
      const handler = createWebdav({
        baseUrl: "https://pod.example",
        backend: () => backend,
      });
      const res = await handler(
        new Request("http://pod.example/a", { method: "GET" }),
        {} as never,
        createExecutionContext(),
      );
      expect(res.status).toBe(403);
    });
  });

  it("demands Basic credentials and rejects a wrong password", async () => {
    await withHandler(async ({ call }) => {
      const noAuth = await call("PROPFIND", "/", {
        auth: false,
        headers: { depth: "0" },
      });
      expect(noAuth.status).toBe(401);
      expect(noAuth.headers.get("WWW-Authenticate")).toContain("Basic");

      const badPass = await call("GET", "/", {
        auth: false,
        headers: { authorization: `Basic ${btoa("wdav-x:nope")}` },
      });
      expect(badPass.status).toBe(401);
    });
  });
});

describe("createWebdav — PUT/GET round-trip (spec §3)", () => {
  it("stores and serves a blob, inferring text/turtle from the extension", async () => {
    await withHandler(async ({ call }) => {
      const put = await call("PUT", "/note.ttl", {
        body: "<a> <b> <c> .",
        headers: { "content-type": "application/octet-stream" },
      });
      expect(put.status).toBe(201);

      const get = await call("GET", "/note.ttl");
      expect(get.status).toBe(200);
      expect(get.headers.get("Content-Type")).toBe("text/turtle");
      expect(await get.text()).toBe("<a> <b> <c> .");

      const head = await call("HEAD", "/note.ttl");
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    });
  });

  it("returns 412 when If-None-Match: * collides with an existing resource", async () => {
    await withHandler(async ({ call }) => {
      expect((await call("PUT", "/x.txt", { body: "one" })).status).toBe(201);
      const second = await call("PUT", "/x.txt", {
        body: "two",
        headers: { "if-none-match": "*" },
      });
      expect(second.status).toBe(412);
    });
  });

  it("honours a read-only app-password scope by refusing writes (scope ∩ WAC)", async () => {
    await withHandler(
      async ({ call }) => {
        expect((await call("PUT", "/ro.txt", { body: "x" })).status).toBe(403);
        // ... but reads are allowed.
        expect(
          (await call("PROPFIND", "/", { headers: { depth: "0" } })).status,
        ).toBe(207);
      },
      { scope: ["read"] },
    );
  });

  it("applies WAC: a denied authorize() yields 403 even within scope", async () => {
    await withHandler(async ({ call, backend }) => {
      backend.allow = (_w, _p, mode) => mode === "read";
      expect((await call("PUT", "/d.txt", { body: "x" })).status).toBe(403);
    });
  });
});

describe("createWebdav — PROPFIND (spec §3/§4)", () => {
  it("returns a 207 multistatus for Depth 0 with live properties", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/a.txt", { body: "hello" });
      const res = await call("PROPFIND", "/a.txt", { headers: { depth: "0" } });
      expect(res.status).toBe(207);
      const body = await res.text();
      expect(body).toContain("<D:multistatus");
      expect(body).toContain("<D:getcontentlength>5</D:getcontentlength>");
      expect(body).toContain("<D:resourcetype/>");
      expect(body).toContain("HTTP/1.1 200 OK");
    });
  });

  it("lists children at Depth 1 and omits auxiliary .acl resources", async () => {
    await withHandler(async ({ call, backend }) => {
      await call("PUT", "/a.txt", { body: "1" });
      await call("MKCOL", "/dir");
      // Seed an auxiliary resource directly; it must never surface over WebDAV.
      backend.resources.set("/a.txt.acl", {
        body: new Uint8Array(),
        contentType: "text/turtle",
        etag: '"acl"',
        lastModified: 0,
        createdAt: 0,
        collection: false,
      });
      const res = await call("PROPFIND", "/", { headers: { depth: "1" } });
      const body = await res.text();
      expect(body).toContain("/a.txt");
      expect(body).toContain("/dir/");
      expect(body).not.toContain(".acl");
      expect(body).toContain("<D:collection/>");
    });
  });

  it("refuses Depth: infinity PROPFIND with 403", async () => {
    await withHandler(async ({ call }) => {
      const res = await call("PROPFIND", "/", {
        headers: { depth: "infinity" },
      });
      expect(res.status).toBe(403);
    });
  });

  it("returns 404 for every verb against an auxiliary .acl resource", async () => {
    await withHandler(async ({ call }) => {
      expect((await call("GET", "/a.txt.acl")).status).toBe(404);
      expect((await call("PUT", "/a.txt.acl", { body: "x" })).status).toBe(404);
      expect(
        (await call("PROPFIND", "/a.txt.meta", { headers: { depth: "0" } }))
          .status,
      ).toBe(404);
    });
  });
});

describe("createWebdav — MKCOL / COPY / MOVE (spec §3)", () => {
  it("creates a collection and rejects a duplicate MKCOL", async () => {
    await withHandler(async ({ call }) => {
      expect((await call("MKCOL", "/docs")).status).toBe(201);
      expect((await call("MKCOL", "/docs")).status).toBe(405);
    });
  });

  it("copies a resource and moves another, dropping the source", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/src.txt", { body: "data" });
      const copy = await call("COPY", "/src.txt", {
        headers: { destination: "https://pod.example/copy.txt" },
      });
      expect(copy.status).toBe(201);
      expect((await call("GET", "/src.txt")).status).toBe(200);
      expect(await (await call("GET", "/copy.txt")).text()).toBe("data");

      const move = await call("MOVE", "/src.txt", {
        headers: { destination: "https://pod.example/moved.txt" },
      });
      expect(move.status).toBe(201);
      expect((await call("GET", "/src.txt")).status).toBe(404);
      expect(await (await call("GET", "/moved.txt")).text()).toBe("data");
    });
  });

  it("refuses to overwrite when Overwrite: F and the destination exists", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/one.txt", { body: "1" });
      await call("PUT", "/two.txt", { body: "2" });
      const res = await call("COPY", "/one.txt", {
        headers: { destination: "https://pod.example/two.txt", overwrite: "F" },
      });
      expect(res.status).toBe(412);
    });
  });

  it("deletes a resource and refuses to delete a non-empty collection", async () => {
    await withHandler(async ({ call }) => {
      await call("MKCOL", "/full");
      await call("PUT", "/full/child.txt", { body: "x" });
      expect((await call("DELETE", "/full/")).status).toBe(409);
      expect((await call("DELETE", "/full/child.txt")).status).toBe(204);
      expect((await call("DELETE", "/full/")).status).toBe(204);
    });
  });
});

describe("createWebdav — Class 2 locking (spec §2)", () => {
  it("locks a resource, blocks an unkeyed write with 423, and admits the keyed write", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/doc.txt", { body: "v1" });
      const lock = await call("LOCK", "/doc.txt", {
        headers: { depth: "0", timeout: "Second-300" },
        body:
          '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:">' +
          "<D:lockscope><D:exclusive/></D:lockscope>" +
          "<D:locktype><D:write/></D:locktype>" +
          "<D:owner>mailto:me@dwk.io</D:owner></D:lockinfo>",
      });
      expect(lock.status).toBe(200);
      const lockBody = await lock.text();
      expect(lockBody).toContain("<D:lockdiscovery>");
      const token = lock.headers.get("Lock-Token")?.replace(/^<|>$/g, "");
      expect(token).toMatch(/^opaquelocktoken:/);

      const blocked = await call("PUT", "/doc.txt", { body: "v2" });
      expect(blocked.status).toBe(423);

      const keyed = await call("PUT", "/doc.txt", {
        body: "v2",
        headers: { if: `(<${token}>)` },
      });
      expect(keyed.status).toBe(204);

      const unlock = await call("UNLOCK", "/doc.txt", {
        headers: { "lock-token": `<${token}>` },
      });
      expect(unlock.status).toBe(204);

      // After UNLOCK the unkeyed write succeeds.
      expect((await call("PUT", "/doc.txt", { body: "v3" })).status).toBe(204);
    });
  });

  it("forbids a Depth: infinity lock on the storage root with 403", async () => {
    await withHandler(async ({ call }) => {
      const res = await call("LOCK", "/", {
        headers: { depth: "infinity" },
        body:
          '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
          "<D:locktype><D:write/></D:locktype></D:lockinfo>",
      });
      expect(res.status).toBe(403);
    });
  });

  it("blocks DELETE and MOVE of a locked resource without the token", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/locked.txt", { body: "x" });
      const lock = await call("LOCK", "/locked.txt", {
        headers: { depth: "0" },
        body:
          '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
          "<D:locktype><D:write/></D:locktype></D:lockinfo>",
      });
      expect(lock.status).toBe(200);
      expect((await call("DELETE", "/locked.txt")).status).toBe(423);
      expect(
        (
          await call("MOVE", "/locked.txt", {
            headers: { destination: "https://pod.example/elsewhere.txt" },
          })
        ).status,
      ).toBe(423);
    });
  });

  it("refreshes a lock when LOCK is sent with no body and the token in If:", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/r.txt", { body: "x" });
      const lock = await call("LOCK", "/r.txt", {
        headers: { depth: "0" },
        body:
          '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
          "<D:locktype><D:write/></D:locktype></D:lockinfo>",
      });
      const token = lock.headers.get("Lock-Token")?.replace(/^<|>$/g, "");
      const refresh = await call("LOCK", "/r.txt", {
        headers: { if: `(<${token}>)`, timeout: "Second-600" },
      });
      expect(refresh.status).toBe(200);
      expect(await refresh.text()).toContain("<D:lockdiscovery>");
    });
  });
});

describe("createWebdav — OS-litter policy (spec §3)", () => {
  it("refuses a litter PUT only when the denylist is enabled", async () => {
    await withHandler(async ({ backend }) => {
      const handler = createWebdav({
        baseUrl: "https://pod.example",
        backend: () => backend,
        denyOsLitter: true,
      });
      const cred = await backend.credentials.mint({
        webid: WEBID,
        label: "l",
        scope: { modes: ["read", "write"] },
        iterations: ITER,
      });
      const basic = `Basic ${btoa(`${cred.username}:${cred.secret}`)}`;
      const res = await handler(
        new Request("https://pod.example/.DS_Store", {
          method: "PUT",
          headers: { authorization: basic },
          body: "junk",
        }),
        {} as never,
        createExecutionContext(),
      );
      expect(res.status).toBe(403);
    });
  });
});

const LOCKINFO =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
  "<D:locktype><D:write/></D:locktype></D:lockinfo>";

describe("createWebdav — PROPPATCH & named PROPFIND (spec §4)", () => {
  it("accepts a dead property (200) and refuses a protected live one (403)", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/p.txt", { body: "x" });
      const res = await call("PROPPATCH", "/p.txt", {
        headers: { "content-type": 'application/xml; charset="utf-8"' },
        body:
          '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:example">' +
          "<D:set><D:prop><Z:author>me</Z:author></D:prop></D:set>" +
          "<D:set><D:prop><D:getetag>nope</D:getetag></D:prop></D:set>" +
          "</D:propertyupdate>",
      });
      expect(res.status).toBe(207);
      const body = await res.text();
      expect(body).toContain("HTTP/1.1 200 OK"); // dead prop accepted-and-ignored
      expect(body).toContain("HTTP/1.1 403 Forbidden"); // protected live prop
      expect(body).toContain('xmlns:x="urn:example"');
    });
  });

  it("reports unknown props in a named PROPFIND as 404", async () => {
    await withHandler(async ({ call }) => {
      await call("PUT", "/n.txt", { body: "x" });
      const res = await call("PROPFIND", "/n.txt", {
        headers: { depth: "0", "content-type": "application/xml" },
        body:
          '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop>' +
          "<D:getetag/><D:getcontentlength/><D:unknownprop/>" +
          "</D:prop></D:propfind>",
      });
      expect(res.status).toBe(207);
      const body = await res.text();
      expect(body).toContain("<D:getetag>");
      expect(body).toContain("HTTP/1.1 200 OK");
      expect(body).toContain("HTTP/1.1 404 Not Found");
      expect(body).toContain("<D:unknownprop/>");
    });
  });

  it("rejects a non-UTF-8 request charset with 415", async () => {
    await withHandler(async ({ call }) => {
      const res = await call("PROPFIND", "/", {
        headers: {
          depth: "0",
          "content-type": 'application/xml; charset="utf-16"',
        },
        body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      });
      expect(res.status).toBe(415);
    });
  });
});

describe("createWebdav — lock/verb edge cases", () => {
  it("refuses to LOCK a non-existent collection with 409", async () => {
    await withHandler(async ({ call }) => {
      const res = await call("LOCK", "/ghost/", {
        headers: { depth: "0" },
        body: LOCKINFO,
      });
      expect(res.status).toBe(409);
    });
  });

  it("blocks MOVE of a collection containing a locked descendant (423)", async () => {
    await withHandler(async ({ call }) => {
      await call("MKCOL", "/box");
      await call("PUT", "/box/item.txt", { body: "x" });
      expect(
        (
          await call("LOCK", "/box/item.txt", {
            headers: { depth: "0" },
            body: LOCKINFO,
          })
        ).status,
      ).toBe(200);
      const move = await call("MOVE", "/box/", {
        headers: { destination: "https://pod.example/moved/" },
      });
      expect(move.status).toBe(423);
    });
  });

  it("UNLOCK requires a token and 409s an unknown one", async () => {
    await withHandler(async ({ call }) => {
      expect((await call("UNLOCK", "/x")).status).toBe(400);
      expect(
        (
          await call("UNLOCK", "/x", {
            headers: { "lock-token": "<opaquelocktoken:ghost>" },
          })
        ).status,
      ).toBe(409);
    });
  });

  it("rejects a MKCOL request body with 415", async () => {
    await withHandler(async ({ call }) => {
      const res = await call("MKCOL", "/withbody", {
        body: "junk",
        headers: { "content-length": "4" },
      });
      expect(res.status).toBe(415);
    });
  });

  it("reports collection metadata with 204 on a bare GET", async () => {
    await withHandler(async ({ call }) => {
      await call("MKCOL", "/col");
      const res = await call("GET", "/col/");
      expect(res.status).toBe(204);
      expect(res.headers.get("ETag")).toBeTruthy();
    });
  });
});
