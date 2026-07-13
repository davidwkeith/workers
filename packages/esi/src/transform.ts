/**
 * Streaming transform — wires the tokenizer and fragment resolver into a
 * `TransformStream<Uint8Array, Uint8Array>` that resolves ESI markup while
 * preserving output order, per
 * `docs/superpowers/specs/2026-07-13-esi-design.md`.
 */

import { noopLogger } from "@dwk/log";
import { resolveFragment, type FragmentFetchOptions } from "./fragment.js";
import { EsiTokenizer, type EsiToken } from "./tokenize.js";

export interface EsiTransformOptions extends FragmentFetchOptions {
  readonly maxIncludes?: number; // default 50
  readonly concurrency?: number; // default 6
}

/** A tiny counting semaphore bounding concurrent fragment fetches. */
class Semaphore {
  #available: number;
  #queue: Array<() => void> = [];

  constructor(count: number) {
    this.#available = count;
  }

  acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve(() => this.#release());
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#available--;
        resolve(() => this.#release());
      });
    });
  }

  #release(): void {
    this.#available++;
    const next = this.#queue.shift();
    if (next) {
      next();
    }
  }
}

/** A TransformStream<Uint8Array, Uint8Array> that resolves ESI markup in
 *  the byte stream passing through it, preserving text order. */
export function createEsiTransformStream(
  options: EsiTransformOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const maxIncludes = options.maxIncludes ?? 50;
  const concurrency = options.concurrency ?? 6;
  const logger = options.logger ?? noopLogger;
  const fragmentOptions: FragmentFetchOptions = {
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    safeFetchOptions: options.safeFetchOptions,
    maxFragmentBytes: options.maxFragmentBytes,
    logger,
    metrics: options.metrics,
  };

  const tokenizer = new EsiTokenizer();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const semaphore = new Semaphore(concurrency);

  let includeCount = 0;
  // A promise chain that serializes emission order: each link only runs
  // once the previous one has fully settled, so output order matches
  // source order even though fragment fetches resolve concurrently and
  // out of order underneath.
  let tail: Promise<void> = Promise.resolve();

  function scheduleBytes(
    bytesPromise: Promise<Uint8Array>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    tail = tail
      .then(() => bytesPromise)
      .then((bytes) => {
        if (bytes.length > 0) {
          controller.enqueue(bytes);
        }
      });
  }

  async function runFragment(
    token: Extract<EsiToken, { kind: "include" }>,
  ): Promise<Uint8Array> {
    const release = await semaphore.acquire();
    try {
      const text = await resolveFragment(token, fragmentOptions);
      return encoder.encode(text);
    } finally {
      release();
    }
  }

  function handleToken(
    token: EsiToken,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (token.kind === "text") {
      scheduleBytes(Promise.resolve(encoder.encode(token.value)), controller);
      return;
    }
    if (token.kind === "remove-block") {
      // Its contents never contribute to output; nothing to schedule.
      return;
    }
    // token.kind === "include"
    includeCount++;
    if (includeCount > maxIncludes) {
      logger.warn("esi.include.dropped_max_includes", { src: token.src });
      return;
    }
    scheduleBytes(runFragment(token), controller);
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      for (const token of tokenizer.push(text)) {
        handleToken(token, controller);
      }
    },
    async flush(controller) {
      const trailingText = decoder.decode();
      if (trailingText.length > 0) {
        for (const token of tokenizer.push(trailingText)) {
          handleToken(token, controller);
        }
      }
      for (const token of tokenizer.flush()) {
        handleToken(token, controller);
      }
      await tail;
    },
  });
}
