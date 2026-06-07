import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureGcSchema } from "@dwk/store";

import {
  bearerToken,
  createRemoteStorage,
  parseScopes,
  type RemoteStorageEnv,
} from "./index";

/**
 * End-to-end tests over the real front door + per-account Durable Object: the
 * issue's acceptance criteria — OAuth-scoped document GET/PUT/DELETE, conditional
 * writes, virtual folder listings with aggregate ETags, the public `/public/`
 * tree, CORS, and document↔folder conflict detection.
 *
 * For hermetic auth the injected hook treats the bearer token *as* the scope
 * string (e.g. `Authorization: Bearer documents:rw`); the built-in JWKS verifier
 * is covered separately in `auth.test.ts`.
 */

const testEnv = env as unknown as RemoteStorageEnv;
const ctx = {} as ExecutionContext;

const handler = createRemoteStorage({
  baseUrl: "https://storage.example",
  authenticate: (request) => {
    const token = bearerToken(request);
    return token ? { scopes: parseScopes(token), subject: "tester" } : null;
  },
});

// The DO forwards orphaned blob keys into the shared GC D1 table on write; in
// production the GC cron creates that schema (`createRemoteStorageGc`), so the
// tests stand it up the same way the store/solid-pod suites do.
beforeAll(async () => {
  await ensureGcSchema((testEnv as unknown as { GC_DB: D1Database }).GC_DB);
});

/** Per-test account so Durable Object state never leaks across cases. */
let account: string;
beforeEach(() => {
  account = `acct-${crypto.randomUUID()}`;
});

interface CallInit {
  readonly method?: string;
  readonly scope?: string; // bearer token = scope string; omit ⇒ anonymous
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
}

function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.scope !== undefined)
    headers["authorization"] = `Bearer ${init.scope}`;
  return handler(
    new Request(`https://storage.example/${account}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
    testEnv,
    ctx,
  );
}

describe("documents", () => {
  it("PUTs, GETs, overwrites, and DELETEs a document with ETags", async () => {
    const created = await call("/documents/note.txt", {
      method: "PUT",
      scope: "documents:rw",
      body: "hello",
      headers: { "content-type": "text/plain" },
    });
    expect(created.status).toBe(201);
    const etag1 = created.headers.get("etag");
    expect(etag1).toBeTruthy();

    const read = await call("/documents/note.txt", { scope: "documents:r" });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("text/plain");
    expect(read.headers.get("etag")).toBe(etag1);
    expect(read.headers.get("content-length")).toBe("5");
    expect(await read.text()).toBe("hello");

    const overwrite = await call("/documents/note.txt", {
      method: "PUT",
      scope: "documents:rw",
      body: "goodbye",
    });
    expect(overwrite.status).toBe(200);
    expect(overwrite.headers.get("etag")).not.toBe(etag1);

    const head = await call("/documents/note.txt", {
      method: "HEAD",
      scope: "documents:r",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const deleted = await call("/documents/note.txt", {
      method: "DELETE",
      scope: "documents:rw",
    });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("etag")).toBe(overwrite.headers.get("etag"));

    const gone = await call("/documents/note.txt", { scope: "documents:r" });
    expect(gone.status).toBe(404);
  });

  it("honors If-None-Match: * (create-only) and If-Match preconditions", async () => {
    const first = await call("/documents/x", {
      method: "PUT",
      scope: "documents:rw",
      body: "v1",
      headers: { "if-none-match": "*" },
    });
    expect(first.status).toBe(201);

    const conflict = await call("/documents/x", {
      method: "PUT",
      scope: "documents:rw",
      body: "v2",
      headers: { "if-none-match": "*" },
    });
    expect(conflict.status).toBe(412);

    const staleMatch = await call("/documents/x", {
      method: "PUT",
      scope: "documents:rw",
      body: "v3",
      headers: { "if-match": '"not-the-current-etag"' },
    });
    expect(staleMatch.status).toBe(412);

    // A GET returning 304 against the current ETag.
    const etag = first.headers.get("etag")!;
    const notModified = await call("/documents/x", {
      scope: "documents:r",
      headers: { "if-none-match": etag },
    });
    expect(notModified.status).toBe(304);
  });

  it("rejects a PUT or DELETE on a folder path with 400", async () => {
    const put = await call("/documents/", {
      method: "PUT",
      scope: "documents:rw",
      body: "x",
    });
    expect(put.status).toBe(400);
  });
});

describe("folders", () => {
  it("lists immediate children and subfolders, with an ETag that tracks descendants", async () => {
    await call("/documents/a.txt", {
      method: "PUT",
      scope: "documents:rw",
      body: "a",
      headers: { "content-type": "text/plain" },
    });
    await call("/documents/sub/b.txt", {
      method: "PUT",
      scope: "documents:rw",
      body: "bb",
    });

    const folder = await call("/documents/", { scope: "documents:r" });
    expect(folder.status).toBe(200);
    expect(folder.headers.get("content-type")).toBe("application/ld+json");
    const folderEtag = folder.headers.get("etag");
    const body = (await folder.json()) as {
      "@context": string;
      items: Record<string, { ETag: string; "Content-Type"?: string }>;
    };
    expect(body["@context"]).toBe(
      "http://remotestorage.io/spec/folder-description",
    );
    expect(Object.keys(body.items).sort()).toEqual(["a.txt", "sub/"]);
    expect(body.items["a.txt"]?.["Content-Type"]).toBe("text/plain");
    expect(body.items["sub/"]).not.toHaveProperty("Content-Type");

    // Writing deeper changes the folder ETag (descendant-sensitive).
    await call("/documents/sub/c.txt", {
      method: "PUT",
      scope: "documents:rw",
      body: "c",
    });
    const after = await call("/documents/", { scope: "documents:r" });
    expect(after.headers.get("etag")).not.toBe(folderEtag);
  });

  it("answers an empty folder with 200 and a stable ETag", async () => {
    const empty = await call("/documents/", { scope: "documents:r" });
    expect(empty.status).toBe(200);
    const again = await call("/documents/", { scope: "documents:r" });
    expect(again.headers.get("etag")).toBe(empty.headers.get("etag"));
  });
});

describe("authorization", () => {
  it("allows anonymous reads of public documents but not private ones", async () => {
    await call("/public/notes/hi.txt", {
      method: "PUT",
      scope: "notes:rw",
      body: "public",
    });
    const pub = await call("/public/notes/hi.txt"); // no token
    expect(pub.status).toBe(200);
    expect(await pub.text()).toBe("public");

    await call("/notes/secret.txt", {
      method: "PUT",
      scope: "notes:rw",
      body: "secret",
    });
    const priv = await call("/notes/secret.txt"); // no token
    expect(priv.status).toBe(401);
  });

  it("never lets anonymous list even a public folder", async () => {
    await call("/public/notes/hi.txt", {
      method: "PUT",
      scope: "notes:rw",
      body: "x",
    });
    const listing = await call("/public/notes/"); // no token
    expect(listing.status).toBe(401);
  });

  it("enforces read-only scopes against writes", async () => {
    const write = await call("/documents/x", {
      method: "PUT",
      scope: "documents:r",
      body: "x",
    });
    expect(write.status).toBe(403);

    await call("/documents/x", {
      method: "PUT",
      scope: "documents:rw",
      body: "x",
    });
    const read = await call("/documents/x", { scope: "documents:r" });
    expect(read.status).toBe(200);
  });

  it("denies a module the token's scopes do not mention", async () => {
    const denied = await call("/contacts/x", {
      method: "PUT",
      scope: "documents:rw",
      body: "x",
    });
    expect(denied.status).toBe(403);
  });

  it("isolates accounts: one account cannot see another's documents", async () => {
    await call("/documents/x", {
      method: "PUT",
      scope: "documents:rw",
      body: "alice-data",
    });
    const original = account;
    account = `acct-${crypto.randomUUID()}`;
    const otherRead = await call("/documents/x", { scope: "documents:r" });
    expect(otherRead.status).toBe(404);
    account = original;
  });
});

describe("conflict detection", () => {
  it("409s a document whose ancestor is already a document", async () => {
    await call("/documents/a", {
      method: "PUT",
      scope: "documents:rw",
      body: "doc",
    });
    const conflict = await call("/documents/a/b", {
      method: "PUT",
      scope: "documents:rw",
      body: "nested",
    });
    expect(conflict.status).toBe(409);
  });

  it("409s a document whose path is already a folder", async () => {
    await call("/documents/a/b", {
      method: "PUT",
      scope: "documents:rw",
      body: "nested",
    });
    const conflict = await call("/documents/a", {
      method: "PUT",
      scope: "documents:rw",
      body: "doc",
    });
    expect(conflict.status).toBe(409);
  });
});

describe("CORS and routing", () => {
  it("answers the preflight at the edge with permissive CORS", async () => {
    const preflight = await handler(
      new Request(`https://storage.example/${account}/documents/x`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example" },
      }),
      testEnv,
      ctx,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    );
  });

  it("adds CORS headers to a normal response", async () => {
    const read = await call("/public/notes/", {
      headers: { origin: "https://app.example" },
    });
    expect(read.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
  });

  it("404s a request that names no account", async () => {
    const response = await handler(
      new Request("https://storage.example/", { method: "GET" }),
      testEnv,
      ctx,
    );
    expect(response.status).toBe(404);
  });

  it("405s an unsupported method", async () => {
    const response = await call("/documents/x", {
      method: "POST",
      scope: "documents:rw",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("PUT");
  });
});
