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
  /**
   * High-water mark on scheduled-but-not-yet-emitted output chunks. Once this
   * many are outstanding (e.g. a slow head-of-line fragment is holding up the
   * ordered tail), `transform` stops accepting input until the tail drains, so
   * the rest of the origin body is not buffered unboundedly. Default 256.
   */
  readonly maxBufferedChunks?: number;
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
  const maxBufferedChunks = options.maxBufferedChunks ?? 256;
  const logger = options.logger ?? noopLogger;
  // Aborted when the stream is canceled (e.g. a client disconnect), so
  // in-flight fragment fetches stop spending Workers subrequest quota on
  // work whose output will never be read.
  const abortController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;
  const fragmentOptions: FragmentFetchOptions = {
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    safeFetchOptions: options.safeFetchOptions,
    maxFragmentBytes: options.maxFragmentBytes,
    logger,
    metrics: options.metrics,
    signal,
  };

  const tokenizer = new EsiTokenizer();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const semaphore = new Semaphore(concurrency);

  let includeCount = 0;
  // Number of chunks scheduled onto `tail` that have not yet been emitted —
  // the live buffer depth, used to apply backpressure (see `transform`).
  let scheduled = 0;
  // A promise chain that serializes emission order: each link only runs
  // once the previous one has fully settled, so output order matches
  // source order even though fragment fetches resolve concurrently and
  // out of order underneath.
  let tail: Promise<void> = Promise.resolve();

  function scheduleBytes(
    bytesPromise: Promise<Uint8Array>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    scheduled++;
    tail = tail
      .then(() => bytesPromise)
      .then((bytes) => {
        scheduled--;
        if (bytes.length > 0) {
          // The stream may already be canceled by the time this settles
          // (a fragment fetch was in flight when the reader disconnected);
          // enqueueing on a canceled controller throws, which would
          // otherwise surface as an unhandled rejection.
          try {
            controller.enqueue(bytes);
          } catch {
            // Stream already closed/canceled; nothing left to deliver to.
          }
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
    async transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      for (const token of tokenizer.push(text)) {
        handleToken(token, controller);
      }
      // Propagate backpressure: if too many chunks are scheduled but not yet
      // emitted (a slow head-of-line fragment holding up the ordered tail),
      // stop pulling input until the tail drains. `tail` never rejects
      // (`resolveFragment` never throws), so this cannot error the stream.
      if (scheduled > maxBufferedChunks) {
        await tail;
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
    cancel(reason) {
      abortController.abort(reason);
    },
  });
}
