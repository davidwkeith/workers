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
} from "./index";
import type { HarnessEnv } from "./test-harness";

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
