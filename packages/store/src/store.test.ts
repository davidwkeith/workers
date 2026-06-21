import { env, runInDurableObject } from "cloudflare:test";
import type { StoredQuad } from "@dwk/rdf";
import { beforeEach, describe, expect, it } from "vitest";

import {
  collectGarbage,
  createStore,
  d1OrphanSink,
  ensureGcSchema,
  forwardOrphans,
  PreconditionFailedError,
  type Store,
} from "./index.js";
import type { HarnessEnv } from "./test-harness.js";

const harness = env as unknown as HarnessEnv;

const EX = "http://example.com/";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const DEFAULT_GRAPH = { termType: "DefaultGraph", value: "" } as const;

// `@dwk/rdf`'s `StoredQuad` shape, built directly so the workerd test stays free
// of n3's Node stream machinery. `@dwk/store` round-trips exactly these.
const QUADS: StoredQuad[] = [
  {
    subject: { termType: "NamedNode", value: `${EX}s` },
    predicate: { termType: "NamedNode", value: `${EX}p` },
    object: { termType: "Literal", value: "hello", datatype: XSD_STRING },
    graph: DEFAULT_GRAPH,
  },
  {
    subject: { termType: "NamedNode", value: `${EX}s` },
    predicate: { termType: "NamedNode", value: `${EX}q` },
    object: { termType: "NamedNode", value: `${EX}o` },
    graph: DEFAULT_GRAPH,
  },
];

const INSERTED: StoredQuad = {
  subject: { termType: "NamedNode", value: `${EX}s` },
  predicate: { termType: "NamedNode", value: `${EX}added` },
  object: { termType: "NamedNode", value: `${EX}z` },
  graph: DEFAULT_GRAPH,
};

/** Arbitrary opaque body used by the routing test (not parsed). */
const BODY_TEXT = "@prefix ex: <http://example.com/> . ex:s ex:p ex:o .";

async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Run `fn` inside a fresh, isolated pod Durable Object with a live store. */
async function withStore<T>(
  fn: (ctx: {
    store: Store;
    env: HarnessEnv;
    state: DurableObjectState;
  }) => T | Promise<T>,
  config?: Parameters<typeof createStore>[2],
): Promise<T> {
  const id = harness.POD_DO.idFromName(crypto.randomUUID());
  const stub = harness.POD_DO.get(id);
  return runInDurableObject(stub, async (instance, state) => {
    const store = createStore(state, instance.bindings, config);
    return fn({ store, env: instance.bindings, state });
  });
}

beforeEach(async () => {
  await ensureGcSchema(harness.GC_DB);
});

describe("@dwk/store quad store", () => {
  it("writes and reads quads transactionally and round-trips the StoredQuad shape", async () => {
    const read = await withStore(({ store }) => {
      const etag = store.writeQuads("/doc", QUADS, {
        contentType: "text/turtle",
      });
      expect(etag).toMatch(/^".+"$/);
      expect(store.head("/doc")).toMatchObject({ kind: "rdf", etag });
      return store.readQuads("/doc");
    });
    expect(read).toHaveLength(QUADS.length);
    expect(new Set(read.map((q) => q.predicate.value))).toEqual(
      new Set(QUADS.map((q) => q.predicate.value)),
    );
    // The literal datatype survives the round-trip.
    const literal = read.find((q) => q.object.termType === "Literal");
    expect(literal?.object).toMatchObject({
      value: "hello",
      datatype: XSD_STRING,
    });
  });

  it("applies an N3-Patch deletes+inserts atomically", async () => {
    const [first, ...rest] = QUADS;
    const result = await withStore(({ store }) => {
      store.writeQuads("/doc", QUADS);
      store.patchQuads("/doc", { deletes: [first!], inserts: [INSERTED] });
      const after = store.readQuads("/doc");
      return {
        predicates: after.map((q) => q.predicate.value).sort(),
        expected: [...rest, INSERTED].map((q) => q.predicate.value).sort(),
      };
    });
    expect(result.predicates).toEqual(result.expected);
  });

  it("rejects a failed If-Match without mutating state", async () => {
    const read = await withStore(({ store }) => {
      store.writeQuads("/doc", QUADS);
      expect(() =>
        store.writeQuads("/doc", [], { ifMatch: '"wrong"' }),
      ).toThrow(PreconditionFailedError);
      return store.readQuads("/doc");
    });
    expect(read).toHaveLength(QUADS.length);
  });

  it("enforces If-None-Match: * (create-only) inside the write transaction", async () => {
    const read = await withStore(({ store }) => {
      // First write creates the resource.
      store.writeQuads("/doc", QUADS, { ifNoneMatch: "*" });
      // A second create-only write must fail and leave state untouched.
      expect(() =>
        store.writeQuads("/doc", [INSERTED], { ifNoneMatch: "*" }),
      ).toThrow(PreconditionFailedError);
      return store.readQuads("/doc");
    });
    expect(read).toHaveLength(QUADS.length);
  });

  it("enforces If-None-Match: * for blob and patch writes", async () => {
    await withStore(async ({ store }) => {
      const bytes = new TextEncoder().encode("opaque");
      await store.putBlob("/blob", bytes, { ifNoneMatch: "*" });
      await expect(
        store.putBlob("/blob", bytes, { ifNoneMatch: "*" }),
      ).rejects.toThrow(PreconditionFailedError);

      store.writeQuads("/rdf", QUADS);
      expect(() =>
        store.patchQuads(
          "/rdf",
          { deletes: [], inserts: [INSERTED] },
          { ifNoneMatch: "*" },
        ),
      ).toThrow(PreconditionFailedError);
    });
  });

  it("rejects If-None-Match against a matching ETag but allows a stale one", async () => {
    await withStore(({ store }) => {
      const etag = store.writeQuads("/doc", QUADS);
      expect(() =>
        store.writeQuads("/doc", [INSERTED], { ifNoneMatch: etag }),
      ).toThrow(PreconditionFailedError);
      // A non-matching ETag does not conflict, so this write proceeds.
      expect(() =>
        store.writeQuads("/doc", [INSERTED], { ifNoneMatch: '"other"' }),
      ).not.toThrow();
    });
  });

  it("lists resources under a key prefix, ordered, without widening on LIKE metacharacters", async () => {
    const result = await withStore(async ({ store }) => {
      const bytes = (s: string) => new TextEncoder().encode(s);
      await store.putBlob("/documents/a.txt", bytes("a"), {
        contentType: "text/plain",
      });
      await store.putBlob("/documents/sub/b.txt", bytes("b"), {
        contentType: "text/plain",
      });
      store.writeQuads("/documents/meta", QUADS, {
        contentType: "text/turtle",
      });
      // Outside the prefix — must not appear.
      await store.putBlob("/photos/c.jpg", bytes("c"));
      // A key whose name embeds a `%` (a LIKE wildcard) sits outside the
      // `/documents/` prefix and must not be pulled in by a naive pattern.
      await store.putBlob("/d%cuments", bytes("x"));

      return {
        all: store.list("/documents/").map((m) => m.key),
        kindOfMeta: store.head("/documents/meta")?.kind,
        docMeta: store.head("/documents/a.txt"),
      };
    });

    expect(result.all).toEqual([
      "/documents/a.txt",
      "/documents/meta",
      "/documents/sub/b.txt",
    ]);
    expect(result.kindOfMeta).toBe("rdf");
    expect(result.docMeta).toMatchObject({
      kind: "blob",
      contentType: "text/plain",
    });
  });
});

describe("@dwk/store blob copy-on-write", () => {
  it("flips the pointer to a new content-addressed key and outboxes the old one", async () => {
    const a = new TextEncoder().encode("version-A");
    const b = new TextEncoder().encode("version-B");
    const out = await withStore(async ({ store, env }) => {
      const etagA = await store.putBlob("/blob", a, {
        contentType: "text/plain",
      });
      const orphansAfterA = store.collectOrphans();
      const etagB = await store.putBlob("/blob", b);
      const body = await store.readBlob("/blob");
      const bytes = body ? await streamToBytes(body.stream) : null;
      const orphans = store.collectOrphans();
      // The displaced key must still be live in R2 (GC reclaims it later).
      const oldStillInR2 = orphans[0]
        ? (await env.BLOBS.get(orphans[0].blobKey)) !== null
        : false;
      return {
        etagA,
        etagB,
        bytes: bytes ? new TextDecoder().decode(bytes) : null,
        orphanCountAfterA: orphansAfterA.length,
        orphanCount: orphans.length,
        oldStillInR2,
        head: store.head("/blob"),
      };
    });
    expect(out.etagA).not.toEqual(out.etagB);
    expect(out.bytes).toBe("version-B");
    expect(out.orphanCountAfterA).toBe(0);
    expect(out.orphanCount).toBe(1);
    expect(out.oldStillInR2).toBe(true);
    expect(out.head).toMatchObject({ kind: "blob", etag: out.etagB });
  });

  it("rejects a failed If-Match before writing R2, leaking no orphan", async () => {
    const a = new TextEncoder().encode("version-A");
    const c = new TextEncoder().encode("version-C");
    const out = await withStore(async ({ store, env, state }) => {
      const etagA = await store.putBlob("/blob", a);
      // A write whose If-Match does not hold must reject ...
      await expect(
        store.putBlob("/blob", c, { ifMatch: '"wrong"' }),
      ).rejects.toThrow(PreconditionFailedError);
      // ... without ever landing the new content-addressed object (the GC has
      // no way to discover an object that was never outboxed).
      const rejectedKeyInR2 = await env.BLOBS.list({
        prefix: `${state.id.toString()}/blobs/`,
      });
      const orphans = store.collectOrphans();
      const body = await store.readBlob("/blob");
      const bytes = body ? await streamToBytes(body.stream) : null;
      return {
        etagA,
        head: store.head("/blob"),
        bytes: bytes ? new TextDecoder().decode(bytes) : null,
        orphanCount: orphans.length,
        r2KeyCount: rejectedKeyInR2.objects.length,
      };
    });
    // The pointer is untouched, no orphan is recorded, and only the surviving
    // version-A object exists in R2 — the version-C write left nothing behind.
    expect(out.head).toMatchObject({ kind: "blob", etag: out.etagA });
    expect(out.bytes).toBe("version-A");
    expect(out.orphanCount).toBe(0);
    expect(out.r2KeyCount).toBe(1);
  });

  it("outboxes the freshly uploaded key when the write transaction rolls back", async () => {
    const body = new TextEncoder().encode("rolled-back");
    const out = await withStore(async ({ store, env }) => {
      // A `guard` that throws stands in for an in-transaction abort that the
      // pre-check cannot catch (a DPoP replay): unlike a deterministic
      // precondition failure, the R2 object has already landed when the pointer
      // flip rolls back, so it must be outboxed for GC instead of leaking.
      const boom = new Error("guard abort");
      await expect(
        store.putBlob("/blob", body, {
          guard: () => {
            throw boom;
          },
        }),
      ).rejects.toBe(boom);

      const orphans = store.collectOrphans();
      const orphanKey = orphans[0]?.blobKey ?? null;
      return {
        head: store.head("/blob"),
        orphanCount: orphans.length,
        // The uploaded object is still in R2 and now tracked for reclamation.
        orphanInR2:
          orphanKey !== null
            ? (await env.BLOBS.get(orphanKey)) !== null
            : false,
      };
    });
    // No pointer was created, but the orphaned blob is queued for GC.
    expect(out.head).toBeNull();
    expect(out.orphanCount).toBe(1);
    expect(out.orphanInR2).toBe(true);
  });
});

describe("@dwk/store streaming blob writes", () => {
  it("hashes a ReadableStream body content-addressably without buffering it", async () => {
    const payload = "streamed-body-contents";
    const out = await withStore(async ({ store, env, state }) => {
      // A streamed write and the equivalent in-memory write dedupe to one
      // content-addressed R2 object (both are SHA-256 of the same bytes) ...
      const streamed = await store.putBlob(
        "/streamed",
        new Response(payload).body!,
        { contentType: "text/plain" },
      );
      const buffered = await store.putBlob(
        "/buffered",
        new TextEncoder().encode(payload),
        { contentType: "text/plain" },
      );
      const blobs = await env.BLOBS.list({
        prefix: `${state.id.toString()}/blobs/sha256-`,
      });
      const body = await store.readBlob("/streamed");
      const bytes = body ? await streamToBytes(body.stream) : null;
      return {
        streamed,
        buffered,
        blobObjectCount: blobs.objects.length,
        roundTrip: bytes ? new TextDecoder().decode(bytes) : null,
        head: store.head("/streamed"),
      };
    });
    // ... but each write gets a fresh per-resource opaque ETag, never a
    // content-addressed one that would collide across distinct resources.
    expect(out.streamed).toMatch(
      /^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/,
    );
    expect(out.streamed).not.toEqual(out.buffered);
    expect(out.blobObjectCount).toBe(1);
    expect(out.roundTrip).toBe(payload);
    expect(out.head).toMatchObject({ kind: "blob", etag: out.streamed });
  });

  it("accepts a Blob body and dedupes identical streamed content", async () => {
    const out = await withStore(async ({ store }) => {
      const a = await store.putBlob("/a", new Blob(["same-bytes"]));
      const b = await store.putBlob("/b", new Blob(["same-bytes"]));
      // Two resources, one shared content-addressed object: removing one must
      // not orphan a key the other still references.
      store.delete("/a");
      return { a, b, orphans: store.collectOrphans().length };
    });
    // Shared bytes dedupe to one R2 object, but each resource keeps its own
    // opaque ETag so an `If-Match` on one cannot be satisfied by the other.
    expect(out.a).not.toEqual(out.b);
    expect(out.orphans).toBe(0);
  });

  it("streams an oversized body through to R2 intact", async () => {
    // Larger than the default tee/chunk sizes so the streaming path is exercised
    // across multiple reads.
    const big = "x".repeat(500_000);
    const out = await withStore(async ({ store }) => {
      await store.putBlob("/big", new Response(big).body!, {
        contentType: "application/octet-stream",
      });
      const body = await store.readBlob("/big");
      const bytes = body ? await streamToBytes(body.stream) : null;
      return {
        size: body?.size,
        matches: bytes ? new TextDecoder().decode(bytes) === big : false,
      };
    });
    expect(out.size).toBe(big.length);
    expect(out.matches).toBe(true);
  });
});

describe("@dwk/store delete → GC ordering", () => {
  it("drops the pointer immediately but reclaims R2 only after the safety window", async () => {
    const body = new TextEncoder().encode("doomed");

    const { blobKey, headAfterDelete, presentAfterDelete } = await withStore(
      async ({ store, env }) => {
        await store.putBlob("/blob", body);
        store.delete("/blob");
        const orphans = store.collectOrphans();
        const key = orphans[0]!.blobKey;
        // Pointer is gone, but the object is still in R2 right after delete.
        const present = (await env.BLOBS.get(key)) !== null;
        // Forward the outbox into the shared D1 tracking store.
        await forwardOrphans(store, d1OrphanSink(env.GC_DB));
        expect(store.collectOrphans()).toHaveLength(0);
        return {
          blobKey: key,
          headAfterDelete: store.head("/blob"),
          presentAfterDelete: present,
        };
      },
    );

    expect(headAfterDelete).toBeNull();
    expect(presentAfterDelete).toBe(true);

    // Inside the safety window: nothing reclaimed.
    const early = await collectGarbage(harness, { safetyWindowMs: 60_000 });
    expect(early).not.toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).not.toBeNull();

    // Past the safety window: the object is reclaimed.
    const reclaimed = await collectGarbage(harness, {
      now: Date.now() + 120_000,
      safetyWindowMs: 60_000,
    });
    expect(reclaimed).toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).toBeNull();
  });

  it("rolls back the delete when the in-transaction guard throws", async () => {
    const stillThere = await withStore(({ store }) => {
      store.writeQuads("/doc", QUADS);
      class Blocked extends Error {}
      expect(() =>
        store.delete("/doc", {
          guard: () => {
            throw new Blocked();
          },
        }),
      ).toThrow(Blocked);
      // The guard aborted the transaction, so the pointer survives.
      return store.head("/doc");
    });
    expect(stillThere).not.toBeNull();
  });
});

describe("@dwk/store resurrection cancels a forwarded GC row", () => {
  it("un-orphans a key resurrected after its orphan row was forwarded", async () => {
    const content = new TextEncoder().encode("resurrect-me");

    const blobKey = await withStore(async ({ store, env }) => {
      await store.putBlob("/a", content);
      store.delete("/a");
      const key = store.collectOrphans()[0]!.blobKey;

      // Forward the orphan into the shared GC store. The local row is retained
      // (marked forwarded) but no longer reported as pending.
      await forwardOrphans(store, d1OrphanSink(env.GC_DB));
      expect(store.collectOrphans()).toHaveLength(0);

      // Resurrect the identical content under a new resource → same key.
      await store.putBlob("/b", content);
      // A cancel tombstone is now pending; draining propagates it to D1.
      await forwardOrphans(store, d1OrphanSink(env.GC_DB));
      return key;
    });

    // The forwarded GC row was cancelled, so the cron GC sees nothing to do.
    const { results } = await harness.GC_DB.prepare(
      "SELECT blob_key FROM orphan_blobs WHERE blob_key = ?",
    )
      .bind(blobKey)
      .all<{ blob_key: string }>();
    expect(results).toHaveLength(0);

    // Even a past-window sweep leaves the now-live resurrected object intact.
    const reclaimed = await collectGarbage(harness, {
      now: Date.now() + 120_000,
      safetyWindowMs: 60_000,
    });
    expect(reclaimed).not.toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).not.toBeNull();
  });

  it("drops a not-yet-forwarded orphan locally without a tombstone", async () => {
    const content = new TextEncoder().encode("quick-resurrect");

    const { pendingOrphans, pendingCancels } = await withStore(
      async ({ store }) => {
        await store.putBlob("/a", content);
        store.delete("/a");
        expect(store.collectOrphans()).toHaveLength(1);
        // Resurrect before forwarding: the local outbox row is simply dropped,
        // so there is nothing to cancel downstream.
        await store.putBlob("/b", content);
        return {
          pendingOrphans: store.collectOrphans().length,
          pendingCancels: store.collectCancels().length,
        };
      },
    );

    expect(pendingOrphans).toBe(0);
    expect(pendingCancels).toBe(0);
  });
});

describe("@dwk/store size-threshold routing", () => {
  it("routes small RDF to SQLite quads and oversized bodies to R2 blobs", async () => {
    const body = new TextEncoder().encode(BODY_TEXT);

    // Generous ceiling → the RDF lives in the quad store.
    const small = await withStore(async ({ store }) => {
      const { tier } = await store.putResource("/doc", body, {
        contentType: "text/turtle",
        quads: QUADS,
      });
      return {
        tier,
        kind: store.head("/doc")?.kind,
        quadCount: store.readQuads("/doc").length,
        blob: await store.readBlob("/doc"),
      };
    });
    expect(small.tier).toBe("sqlite");
    expect(small.kind).toBe("rdf");
    expect(small.quadCount).toBe(QUADS.length);
    expect(small.blob).toBeNull();

    // Tiny ceiling → the identical body is offloaded to R2 as an opaque blob.
    const large = await withStore(
      async ({ store }) => {
        const { tier } = await store.putResource("/doc", body, {
          contentType: "text/turtle",
          quads: QUADS,
        });
        const blob = await store.readBlob("/doc");
        return {
          tier,
          kind: store.head("/doc")?.kind,
          quadCount: store.readQuads("/doc").length,
          bytes: blob ? await streamToBytes(blob.stream) : null,
        };
      },
      { maxInlineBytes: 8 },
    );
    expect(large.tier).toBe("r2");
    expect(large.kind).toBe("blob");
    expect(large.quadCount).toBe(0);
    expect(large.bytes && new TextDecoder().decode(large.bytes)).toBe(
      BODY_TEXT,
    );
  });
});

describe("@dwk/store fails loudly on missing bindings", () => {
  it("throws when the required R2 binding is absent", async () => {
    const id = harness.POD_DO.idFromName(crypto.randomUUID());
    const stub = harness.POD_DO.get(id);
    await runInDurableObject(stub, (instance, state) => {
      const broken = {
        ...instance.bindings,
        BLOBS: undefined,
      } as unknown as HarnessEnv;
      expect(() => createStore(state, broken)).toThrow(/BLOBS/);
    });
  });
});
