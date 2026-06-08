/**
 * `ExecutionContext` shim and the background-work tracker behind it.
 *
 * On Cloudflare, `ctx.waitUntil(promise)` keeps the isolate alive for background
 * work after the response is returned. On Node the process is long-lived, so the
 * shim simply lets the promise run and **tracks it for graceful shutdown
 * draining** — `drain()` waits for in-flight background work before the host
 * exits. `passThroughOnException` and `props` are no-ops, matching the parts of
 * the interface the packages actually touch.
 *
 * @see spec/self-hosting.md §7.5
 */

/**
 * Collects `waitUntil` promises across all requests so the host can wait for
 * outstanding background work during a graceful shutdown.
 */
export class WaitUntilTracker {
  readonly #pending = new Set<Promise<unknown>>();

  /** Register a background promise; it is auto-removed once it settles. */
  add(promise: Promise<unknown>): void {
    // Swallow rejections here so an unhandled background failure never crashes
    // the process; the work's own code is responsible for its error handling.
    const tracked = Promise.resolve(promise).then(
      () => {},
      () => {},
    );
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /** Number of background promises still in flight. */
  get size(): number {
    return this.#pending.size;
  }

  /** Resolve once all currently-tracked background work has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
}

/**
 * A Node-side `ExecutionContext`. Each request gets one; its `waitUntil` work is
 * funnelled into the shared {@link WaitUntilTracker} for shutdown draining.
 */
export class HostExecutionContext implements ExecutionContext {
  readonly #tracker: WaitUntilTracker;

  /** Mirror of Cloudflare's `ctx.props`; unused by the packages, kept for parity. */
  readonly props: Record<string, unknown> = {};

  constructor(tracker: WaitUntilTracker) {
    this.#tracker = tracker;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.#tracker.add(promise);
  }

  passThroughOnException(): void {
    // No-op: on Node there is no isolate to pass an exception through to.
  }
}
