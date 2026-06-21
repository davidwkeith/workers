import { describe, expect, it } from "vitest";

import { readCar, writeCar, type CarBlock } from "./car.js";
import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";

async function block(value: { [k: string]: number }): Promise<CarBlock> {
  const bytes = encodeCbor(value);
  return { cid: await CID.create(DAG_CBOR_CODEC, bytes), bytes };
}

describe("CAR", () => {
  it("round-trips roots and blocks", async () => {
    const blocks = [await block({ a: 1 }), await block({ b: 2 })];
    const root = blocks[0]!.cid;
    const car = writeCar([root], blocks);
    const parsed = readCar(car);

    expect(parsed.roots.length).toBe(1);
    expect(parsed.roots[0]!.equals(root)).toBe(true);
    expect(parsed.blocks.length).toBe(2);
    for (let i = 0; i < blocks.length; i++) {
      expect(parsed.blocks[i]!.cid.equals(blocks[i]!.cid)).toBe(true);
      expect([...parsed.blocks[i]!.bytes]).toEqual([...blocks[i]!.bytes]);
    }
  });

  it("rejects a non-v1 CAR", () => {
    expect(() => readCar(new Uint8Array([0x00]))).toThrow();
  });
});
