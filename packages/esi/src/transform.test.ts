import { describe, expect, it } from "vitest";
import { createEsiTransformStream } from "./transform.js";
import type { FetchLike } from "@dwk/safe-fetch";
import type { Logger } from "@dwk/log";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function runStream(
  transform: TransformStream<Uint8Array, Uint8Array>,
  chunks: Array<Uint8Array | string>,
): Promise<string> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const encoder = new TextEncoder();
  const output: Uint8Array[] = [];

  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        output.push(value);
      }
    }
  })();

  for (const chunk of chunks) {
    await writer.write(
      typeof chunk === "string" ? encoder.encode(chunk) : chunk,
    );
  }
  await writer.close();
  await readLoop;

  return new TextDecoder().decode(concat(output));
}

function fakeLogger(): Logger & { warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  return {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    error: () => {},
    warnCalls,
  };
}

describe("createEsiTransformStream", () => {
  it("preserves output order even when a later fragment resolves first", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      const id = calls++;
      await sleep(id === 0 ? 30 : 5);
      return new Response(`frag${id}`);
    };

    const stream = createEsiTransformStream({ fetch: fetchFn });
    const out = await runStream(stream, [
      'A<esi:include src="https://example.com/a"/>B<esi:include src="https://example.com/b"/>C',
    ]);
    expect(out).toBe("Afrag0Bfrag1C");
  });

  it("drops includes beyond maxIncludes with a warn log, without affecting earlier ones", async () => {
    const fetchFn: FetchLike = async (input) => new Response(`F(${input})`);
    const logger = fakeLogger();

    const stream = createEsiTransformStream({
      fetch: fetchFn,
      maxIncludes: 2,
      logger,
    });
    const out = await runStream(stream, [
      '<esi:include src="https://example.com/1"/><esi:include src="https://example.com/2"/><esi:include src="https://example.com/3"/>',
    ]);
    expect(out).toBe("F(https://example.com/1)F(https://example.com/2)");
    expect(logger.warnCalls.length).toBe(1);
    expect(logger.warnCalls[0]?.[0]).toBe("esi.include.dropped_max_includes");
    // Host-only: the full src URL (path/query) must never reach the logger.
    expect(logger.warnCalls[0]?.[1]).toEqual({ host: "example.com" });
  });

  it("never exceeds the configured concurrency of in-flight fragment fetches", async () => {
    let active = 0;
    let peak = 0;
    const fetchFn: FetchLike = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
      return new Response("F");
    };

    const includes = Array.from(
      { length: 5 },
      (_, i) => `<esi:include src="https://example.com/${i}"/>`,
    ).join("");
    const stream = createEsiTransformStream({ fetch: fetchFn, concurrency: 2 });
    await runStream(stream, [includes]);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it("decodes a multi-byte UTF-8 character split across two written chunks", async () => {
    const original = "hello \u{1F600} world"; // grinning face emoji, 4 UTF-8 bytes
    const bytes = new TextEncoder().encode(original);
    const emojiStart = new TextEncoder().encode("hello ").length;
    // Split two bytes into the 4-byte emoji sequence.
    const splitPoint = emojiStart + 2;

    const stream = createEsiTransformStream();
    const out = await runStream(stream, [
      bytes.slice(0, splitPoint),
      bytes.slice(splitPoint),
    ]);
    expect(out).toBe(original);
  });

  it("resolves an esi:include tag whose bytes are split across two written chunks", async () => {
    const fetchFn: FetchLike = async () => new Response("<b>frag</b>");
    const full =
      'before<esi:include src="https://example.com/frag" alt="https://example.com/fallback"/>after';
    const bytes = new TextEncoder().encode(full);
    const splitPoint = full.indexOf('src="https://example.com/frag"') + 4; // inside the tag

    const stream = createEsiTransformStream({ fetch: fetchFn });
    const out = await runStream(stream, [
      bytes.slice(0, splitPoint),
      bytes.slice(splitPoint),
    ]);
    expect(out).toBe("before<b>frag</b>after");
  });

  it("aborts in-flight fragment fetches when the stream is canceled", async () => {
    let resolveFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let sawSignal: AbortSignal | undefined;
    const fetchFn: FetchLike = (_input, init) => {
      sawSignal = init?.signal ?? undefined;
      resolveFetchStarted();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    };

    const stream = createEsiTransformStream({ fetch: fetchFn });
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // A TransformStream's writable side starts backpressured until the
    // readable side is actively pulled, so an idle reader (as in a real
    // consumer that hasn't read yet) would otherwise deadlock write().
    const readLoop = (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) {
            break;
          }
        }
      } catch {
        // Expected once the reader is canceled below.
      }
    })();

    await writer.write(
      new TextEncoder().encode('<esi:include src="https://example.com/a"/>'),
    );
    await fetchStarted;
    expect(sawSignal?.aborted).toBe(false);

    await reader.cancel("client disconnected");
    await readLoop;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sawSignal?.aborted).toBe(true);

    await writer.abort().catch(() => {});
  });

  it("applies backpressure when the buffer fills behind a slow head-of-line fragment", async () => {
    let releaseFragment!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFragment = resolve;
    });
    const fetchFn: FetchLike = async () => {
      await gate;
      return new Response("FRAG");
    };
    const stream = createEsiTransformStream({
      fetch: fetchFn,
      maxBufferedChunks: 2,
    });
    const enc = new TextEncoder();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const out: Uint8Array[] = [];
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) out.push(value);
      }
    })();

    // A slow head-of-line include, then a run of text chunks.
    await writer.write(
      enc.encode('<esi:include src="https://example.com/slow"/>'),
    );
    let written = 0;
    const writeRest = (async () => {
      for (let i = 0; i < 10; i++) {
        await writer.write(enc.encode(`t${i} `));
        written++;
      }
      await writer.close();
    })();

    // Backpressure must stall the writes: the buffer cannot grow past the mark
    // while the head-of-line fragment is pending, and nothing is emitted yet.
    await sleep(20);
    expect(written).toBeLessThanOrEqual(2);
    expect(out.length).toBe(0);

    // Releasing the fragment drains the tail and lets the writes complete.
    releaseFragment();
    await writeRest;
    await readLoop;
    expect(written).toBe(10);
    expect(new TextDecoder().decode(concat(out))).toBe(
      "FRAGt0 t1 t2 t3 t4 t5 t6 t7 t8 t9 ",
    );
  });
});
