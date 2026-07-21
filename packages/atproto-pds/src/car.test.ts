import { describe, expect, it } from "vitest";

import { readCar, writeCar, writeCarStream, type CarBlock } from "./car.js";
import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";

async function block(value: { [k: string]: number }): Promise<CarBlock> {
  const bytes = encodeCbor(value);
  return { cid: await CID.create(DAG_CBOR_CODEC, bytes), bytes };
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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

  it("writeCarStream produces byte-identical output to writeCar", async () => {
    const blocks = [await block({ a: 1 }), await block({ b: 2 })];
    const root = blocks[0]!.cid;
    const buffered = writeCar([root], blocks);
    const streamed = await readAll(writeCarStream([root], blocks));
    expect([...streamed]).toEqual([...buffered]);
  });

  it("writeCarStream never fully drains the block iterator before the stream is read", async () => {
    const blocks = [await block({ a: 1 }), await block({ b: 2 })];
    const root = blocks[0]!.cid;
    let pulled = 0;
    function* lazyBlocks(): Generator<CarBlock> {
      for (const b of blocks) {
        pulled++;
        yield b;
      }
    }
    const stream = writeCarStream([root], lazyBlocks());
    // Constructing the stream must not eagerly drain the generator — the
    // whole point is that a caller backed by, say, a SQL cursor never
    // materializes every block up front.
    expect(pulled).toBe(0);
    const out = await readAll(stream);
    // Fully consumed, exactly once each, only once the stream was read.
    expect(pulled).toBe(blocks.length);
    expect([...out]).toEqual([...writeCar([root], blocks)]);
  });

  it("writeCarStream releases the block iterator when the reader cancels early", async () => {
    const blocks = [
      await block({ a: 1 }),
      await block({ b: 2 }),
      await block({ c: 3 }),
    ];
    const root = blocks[0]!.cid;
    let returned = false;
    function* trackedBlocks(): Generator<CarBlock> {
      try {
        yield* blocks;
      } finally {
        returned = true;
      }
    }
    const stream = writeCarStream([root], trackedBlocks());
    const reader = stream.getReader();
    await reader.read(); // header
    await reader.read(); // first block — the generator body has now started,
    // so it holds whatever resource (e.g. a SQL cursor) its `try` opened
    expect(returned).toBe(false);
    await reader.cancel("client disconnected mid-sync");
    expect(returned).toBe(true);
  });
});
