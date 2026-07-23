import {
  createExecutionContext,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createStore, ensureGcSchema } from "@dwk/store";
import { CredentialStore, type AppPasswordScope } from "@dwk/webdav";

import { createSolidPodWebdav, type SolidPodEnv } from "./index.js";

/**
 * End-to-end tests for the WebDAV "second door": the real
 * {@link createSolidPodWebdav} front door → the per-pod {@link SolidPodObject}
 * → the Class 2 verb router over the pod's store and lock / app-password SQLite.
 * App passwords are seeded straight into the pod DO's `CredentialStore` (the
 * same table the DO verifies against), standing in for the owner-gated mint
 * endpoint that lands in a later increment.
 */

const testEnv = env as unknown as SolidPodEnv;
const OWNER = "https://owner.example/profile#me";

/** A fresh, isolated pod base URL per test so DOs never share state. */
function freshBase(): string {
  return `https://pod-${crypto.randomUUID()}.example`;
}

/** Seed an app password into the pod DO that `idFromName(baseUrl)` resolves to. */
async function mintCredential(
  baseUrl: string,
  scope: AppPasswordScope,
): Promise<{ username: string; secret: string }> {
  const stub = testEnv.POD.get(testEnv.POD.idFromName(baseUrl));
  const minted = await runInDurableObject(stub, (_instance, state) =>
    new CredentialStore(state.storage.sql).mint({
      webid: OWNER,
      label: "Finder",
      scope,
      iterations: 1000,
    }),
  );
  return { username: minted.username, secret: minted.secret };
}

interface Caller {
  call: (
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: string; auth?: boolean },
  ) => Promise<Response>;
  baseUrl: string;
}

async function withPod(
  scope: AppPasswordScope,
  fn: (c: Caller) => Promise<void>,
): Promise<void> {
  const baseUrl = freshBase();
  const cred = await mintCredential(baseUrl, scope);
  const basic = `Basic ${btoa(`${cred.username}:${cred.secret}`)}`;
  const handler = createSolidPodWebdav({ baseUrl, owner: OWNER });
  const call: Caller["call"] = (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.auth !== false) headers["authorization"] = basic;
    const reqInit: RequestInit = { method, headers };
    if (init.body !== undefined) reqInit.body = init.body;
    return handler(
      new Request(`${baseUrl}${path}`, reqInit),
      testEnv,
      createExecutionContext(),
    );
  };
  await fn({ call, baseUrl });
}

// The pod drains displaced/deleted blobs into the shared D1 GC table; create
// its schema so blob overwrites/deletes don't trip an uninitialized D1.
beforeEach(async () => {
  await ensureGcSchema(testEnv.GC_DB as D1Database);
});

const RW: AppPasswordScope = { modes: ["read", "write"] };

const LOCKINFO =
  '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
  "<D:locktype><D:write/></D:locktype></D:lockinfo>";

describe("@dwk/solid-pod WebDAV door", () => {
  it("advertises Class 2 on OPTIONS without authentication", async () => {
    await withPod(RW, async ({ call }) => {
      const res = await call("OPTIONS", "/", { auth: false });
      expect(res.status).toBe(204);
      expect(res.headers.get("DAV")).toBe("1, 2");
    });
  });

  it("rejects a request with no app-password credentials", async () => {
    await withPod(RW, async ({ call }) => {
      const res = await call("PROPFIND", "/", {
        auth: false,
        headers: { depth: "0" },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    });
  });

  it("PUTs a Turtle resource and serves it back over GET", async () => {
    await withPod(RW, async ({ call }) => {
      const put = await call("PUT", "/note.ttl", {
        body: "<https://pod.example/note.ttl> <https://example/p> <https://example/o> .",
        headers: { "content-type": "text/turtle" },
      });
      expect(put.status).toBe(201);

      const get = await call("GET", "/note.ttl");
      expect(get.status).toBe(200);
      expect(get.headers.get("Content-Type")).toContain("text/turtle");
      expect(await get.text()).toContain("example/p");
    });
  });

  it("stores a generic-typed .ttl into the quad store via extension inference", async () => {
    await withPod(RW, async ({ call }) => {
      // Finder PUTs with application/octet-stream; inference routes it to RDF.
      await call("PUT", "/inferred.ttl", {
        body: "<https://pod.example/inferred.ttl> <https://example/a> <https://example/b> .",
        headers: { "content-type": "application/octet-stream" },
      });
      const get = await call("GET", "/inferred.ttl");
      expect(get.headers.get("Content-Type")).toContain("text/turtle");
      expect(await get.text()).toContain("example/a");
    });
  });

  it("lists a container's children at Depth 1", async () => {
    await withPod(RW, async ({ call }) => {
      await call("PUT", "/a.txt", { body: "alpha" });
      const res = await call("PROPFIND", "/", { headers: { depth: "1" } });
      expect(res.status).toBe(207);
      const body = await res.text();
      expect(body).toContain("<D:multistatus");
      expect(body).toContain("/a.txt");
    });
  });

  it("never resolves a forged cross-origin ldp:contains quad to a spoofed child path (#337)", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("PUT", "/a.txt", { body: "alpha" });

      // Simulate a forged cross-origin `ldp:contains` triple landing in the
      // container's quads — regardless of how it gets there, `listChildren`'s
      // origin check must never resolve it to a same-origin-looking path via
      // a naive string-prefix match (`baseUrl` + ".attacker.com" also starts
      // with `baseUrl`'s characters). To make this a real discriminating
      // test (not just "nothing to find either way"), a resource is created
      // at the exact key a buggy prefix-match slice would have produced —
      // pre-fix this would list; post-fix `toPath` excludes it before ever
      // reaching a store lookup.
      const collidingKey = ".attacker.com/evil";
      const stub = testEnv.POD.get(testEnv.POD.idFromName(baseUrl));
      await runInDurableObject(stub, (_instance, state) => {
        const store = createStore(state, testEnv);
        store.writeQuads(collidingKey, [
          {
            subject: { termType: "NamedNode", value: "tag:test" },
            predicate: { termType: "NamedNode", value: "tag:marker" },
            object: {
              termType: "Literal",
              value: "spoofed",
              datatype: "http://www.w3.org/2001/XMLSchema#string",
            },
            graph: { termType: "DefaultGraph", value: "" },
          },
        ]);
        const existing = store.readQuads("/");
        store.writeQuads("/", [
          ...existing,
          {
            subject: { termType: "NamedNode", value: `${baseUrl}/` },
            predicate: {
              termType: "NamedNode",
              value: "http://www.w3.org/ns/ldp#contains",
            },
            object: {
              termType: "NamedNode",
              value: `${baseUrl}${collidingKey}`,
            },
            graph: { termType: "DefaultGraph", value: "" },
          },
        ]);
      });

      const res = await call("PROPFIND", "/", { headers: { depth: "1" } });
      expect(res.status).toBe(207);
      const body = await res.text();
      expect(body).toContain("/a.txt");
      expect(body).not.toContain("attacker.com");
    });
  });

  it("reports real getcontentlength and getlastmodified in PROPFIND", async () => {
    await withPod(RW, async ({ call }) => {
      await call("PUT", "/sized.bin", {
        body: "12345",
        headers: { "content-type": "application/octet-stream" },
      });
      const res = await call("PROPFIND", "/sized.bin", {
        headers: { depth: "0" },
      });
      const body = await res.text();
      // The store now tracks byte size + mtime, so these are real, not stand-ins.
      expect(body).toContain("<D:getcontentlength>5</D:getcontentlength>");
      expect(body).toContain("<D:getlastmodified>");
      expect(body).not.toContain("01 Jan 1970");
    });
  });

  it("creates a collection with MKCOL and refuses a duplicate", async () => {
    await withPod(RW, async ({ call }) => {
      expect((await call("MKCOL", "/docs")).status).toBe(201);
      expect((await call("MKCOL", "/docs")).status).toBe(405);
    });
  });

  // litmus `mkcol_no_parent` / `put_no_parent`: unlike the LDP door (which
  // auto-vivifies missing ancestor containers), the WebDAV door must 409
  // rather than silently create the intermediate collection.
  it("409s a MKCOL/PUT whose immediate parent collection doesn't exist", async () => {
    await withPod(RW, async ({ call }) => {
      expect((await call("MKCOL", "/missing/child")).status).toBe(409);
      expect(
        (await call("PUT", "/missing/child.txt", { body: "x" })).status,
      ).toBe(409);
    });
  });

  // litmus `mkcol_over_plain`: MKCOL naming an existing plain resource must
  // refuse, not create a same-named collection alongside it.
  it("405s a MKCOL over an existing plain resource", async () => {
    await withPod(RW, async ({ call }) => {
      await call("PUT", "/plain.txt", { body: "x" });
      expect((await call("MKCOL", "/plain.txt")).status).toBe(405);
    });
  });

  it("locks a resource, blocks an unkeyed write (423), then admits the keyed one", async () => {
    await withPod(RW, async ({ call }) => {
      await call("PUT", "/doc.txt", { body: "v1" });
      const lock = await call("LOCK", "/doc.txt", {
        headers: { depth: "0", timeout: "Second-300" },
        body: LOCKINFO,
      });
      expect(lock.status).toBe(200);
      const token = lock.headers.get("Lock-Token")?.replace(/^<|>$/g, "");
      expect(token).toMatch(/^opaquelocktoken:/);

      expect((await call("PUT", "/doc.txt", { body: "v2" })).status).toBe(423);
      expect(
        (
          await call("PUT", "/doc.txt", {
            body: "v2",
            headers: { if: `(<${token}>)` },
          })
        ).status,
      ).toBe(204);

      expect(
        (
          await call("UNLOCK", "/doc.txt", {
            headers: { "lock-token": `<${token}>` },
          })
        ).status,
      ).toBe(204);
      expect((await call("PUT", "/doc.txt", { body: "v3" })).status).toBe(204);
    });
  });

  it("deletes a resource and protects the storage root", async () => {
    await withPod(RW, async ({ call }) => {
      await call("PUT", "/gone.txt", { body: "x" });
      expect((await call("DELETE", "/gone.txt")).status).toBe(204);
      expect((await call("GET", "/gone.txt")).status).toBe(404);
      // The storage root container is undeletable on the WebDAV door too.
      expect((await call("DELETE", "/")).status).toBe(405);
    });
  });

  // litmus `delete_null`: DELETE on a resource that never existed must 404.
  it("404s a DELETE of a resource that never existed", async () => {
    await withPod(RW, async ({ call }) => {
      expect((await call("DELETE", "/never.txt")).status).toBe(404);
    });
  });

  it("refuses a write outside a read-only app-password scope", async () => {
    await withPod({ modes: ["read"] }, async ({ call }) => {
      expect((await call("PUT", "/ro.txt", { body: "x" })).status).toBe(403);
    });
  });

  it("streams a PUT larger than the inline ceiling instead of failing 411", async () => {
    const baseUrl = freshBase();
    const cred = await mintCredential(baseUrl, RW);
    const basic = `Basic ${btoa(`${cred.username}:${cred.secret}`)}`;
    // A tiny inline ceiling forces the size-routing path; the declared
    // Content-Length must let the body stream to R2 rather than 411.
    const handler = createSolidPodWebdav({
      baseUrl,
      owner: OWNER,
      maxInlineBytes: 8,
    });
    const body = "x".repeat(64);
    const put = await handler(
      new Request(`${baseUrl}/big.bin`, {
        method: "PUT",
        headers: {
          authorization: basic,
          "content-type": "application/octet-stream",
          "content-length": "64",
        },
        body,
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(put.status).toBe(201);
    const get = await handler(
      new Request(`${baseUrl}/big.bin`, {
        method: "GET",
        headers: { authorization: basic },
      }),
      testEnv,
      createExecutionContext(),
    );
    expect(await get.text()).toBe(body);
  });

  it("COPYs a resource, leaving the source, and MOVEs another, dropping it", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("PUT", "/src.txt", { body: "data" });
      const copy = await call("COPY", "/src.txt", {
        headers: { destination: `${baseUrl}/copy.txt` },
      });
      expect(copy.status).toBe(201);
      expect((await call("GET", "/src.txt")).status).toBe(200);
      expect(await (await call("GET", "/copy.txt")).text()).toBe("data");

      const move = await call("MOVE", "/src.txt", {
        headers: { destination: `${baseUrl}/moved.txt` },
      });
      expect(move.status).toBe(201);
      expect((await call("GET", "/src.txt")).status).toBe(404);
      expect(await (await call("GET", "/moved.txt")).text()).toBe("data");
    });
  });

  // litmus copymove `copy_nodestcoll`/RFC 4918 §9.8.5/§9.9.4: COPY/MOVE onto
  // a destination whose immediate parent collection doesn't exist must 409.
  it("409s a COPY/MOVE whose destination's parent collection doesn't exist", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("PUT", "/src.txt", { body: "data" });
      const copy = await call("COPY", "/src.txt", {
        headers: { destination: `${baseUrl}/missing/copy.txt` },
      });
      expect(copy.status).toBe(409);

      await call("PUT", "/src2.txt", { body: "data" });
      const move = await call("MOVE", "/src2.txt", {
        headers: { destination: `${baseUrl}/missing/moved.txt` },
      });
      expect(move.status).toBe(409);
    });
  });

  it("COPYs a collection and its children (Depth: infinity)", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("MKCOL", "/box");
      await call("PUT", "/box/a.txt", { body: "alpha" });
      await call("PUT", "/box/b.txt", { body: "beta" });
      const copy = await call("COPY", "/box/", {
        headers: { destination: `${baseUrl}/clone/` },
      });
      expect(copy.status).toBe(201);
      expect(await (await call("GET", "/clone/a.txt")).text()).toBe("alpha");
      expect(await (await call("GET", "/clone/b.txt")).text()).toBe("beta");
      // The source collection is untouched by a COPY.
      expect(await (await call("GET", "/box/a.txt")).text()).toBe("alpha");
      // The copied container lists its own (new) members.
      const propfind = await call("PROPFIND", "/clone/", {
        headers: { depth: "1" },
      });
      const body = await propfind.text();
      expect(body).toContain("/clone/a.txt");
      expect(body).toContain("/clone/b.txt");
    });
  });

  it("normalizes a collection destination that omits the trailing slash", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("MKCOL", "/box");
      await call("PUT", "/box/a.txt", { body: "alpha" });
      // Destination `/clone` (no slash) for a collection source must be treated
      // as `/clone/` so child keys are not corrupted into `/clonea.txt`.
      const copy = await call("COPY", "/box/", {
        headers: { destination: `${baseUrl}/clone` },
      });
      expect(copy.status).toBe(201);
      expect(await (await call("GET", "/clone/a.txt")).text()).toBe("alpha");
      expect((await call("GET", "/clonea.txt")).status).toBe(404);
    });
  });

  it("MOVEs a collection subtree and drops the source", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("MKCOL", "/old");
      await call("PUT", "/old/file.txt", { body: "x" });
      const move = await call("MOVE", "/old/", {
        headers: { destination: `${baseUrl}/new/` },
      });
      expect(move.status).toBe(201);
      expect(await (await call("GET", "/new/file.txt")).text()).toBe("x");
      expect((await call("GET", "/old/file.txt")).status).toBe(404);
    });
  });

  it("refuses to overwrite without Overwrite, and refuses MOVE of the root", async () => {
    await withPod(RW, async ({ call, baseUrl }) => {
      await call("PUT", "/one.txt", { body: "1" });
      await call("PUT", "/two.txt", { body: "2" });
      const noOverwrite = await call("COPY", "/one.txt", {
        headers: { destination: `${baseUrl}/two.txt`, overwrite: "F" },
      });
      expect(noOverwrite.status).toBe(412);
      // The storage root is immovable.
      expect(
        (await call("MOVE", "/", { headers: { destination: `${baseUrl}/x/` } }))
          .status,
      ).toBe(405);
    });
  });
});
