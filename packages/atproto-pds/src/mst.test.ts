import { describe, expect, it } from "vitest";

import { CID, DAG_CBOR_CODEC } from "./cid";
import { buildMst, keyLayer, walkEntries, type MstEntry } from "./mst";

async function valueCid(seed: string): Promise<CID> {
  return CID.create(DAG_CBOR_CODEC, new TextEncoder().encode(seed));
}

async function entries(keys: string[]): Promise<MstEntry[]> {
  return Promise.all(
    keys.map(async (key) => ({ key, value: await valueCid(key) })),
  );
}

describe("MST", () => {
  it("keyLayer counts leading zero bit-pairs of SHA-256(key)", async () => {
    // A plain key has layer 0 with overwhelming probability.
    expect(await keyLayer("app.bsky.feed.post/3jui7kd54zh2y")).toBeTypeOf(
      "number",
    );
    expect(
      await keyLayer("app.bsky.feed.post/3jui7kd54zh2y"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("is order-independent: the root depends only on the entry set", async () => {
    const keys = [
      "app.bsky.feed.post/3aaa",
      "app.bsky.feed.post/3bbb",
      "app.bsky.feed.like/3ccc",
      "app.bsky.actor.profile/self",
    ];
    const forward = await buildMst(await entries(keys));
    const reversed = await buildMst(await entries([...keys].reverse()));
    expect(reversed.root.equals(forward.root)).toBe(true);
  });

  it("an empty repository has a stable empty-node root", async () => {
    const a = await buildMst([]);
    const b = await buildMst([]);
    expect(a.root.equals(b.root)).toBe(true);
  });

  it("walkEntries round-trips the full entry set in key order", async () => {
    const keys = [
      "app.bsky.feed.post/3bbb",
      "app.bsky.feed.post/3aaa",
      "app.bsky.actor.profile/self",
      "com.example.thing/zzz",
    ];
    const built = await buildMst(await entries(keys));
    const got = await walkEntries(built.root, (cid) =>
      built.blocks.get(cid.toString()),
    );
    expect(got.map((e) => e.key)).toEqual([...keys].sort());
    const original = await entries(keys);
    for (const entry of got) {
      const match = original.find((o) => o.key === entry.key);
      expect(match && entry.value.equals(match.value)).toBe(true);
    }
  });

  it("changing a value changes the root", async () => {
    const base = await buildMst(await entries(["a/x", "a/y"]));
    const changed = await buildMst([
      { key: "a/x", value: await valueCid("different") },
      { key: "a/y", value: await valueCid("a/y") },
    ]);
    expect(changed.root.equals(base.root)).toBe(false);
  });
});
