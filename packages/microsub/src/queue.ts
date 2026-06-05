/**
 * `@dwk/microsub` — queued job shapes.
 *
 * Polling — the slow, failure-prone work of fetching and parsing every followed
 * feed — runs off the request path, on a queue with retries and backoff
 * (`spec/packages/microsub.md`). The scheduled poller enqueues one job per
 * distinct followed feed; the consumer fetches and appends. A single job kind
 * flows through the queue today, discriminated by `kind` so the shape can grow.
 *
 * @packageDocumentation
 */

/**
 * Poll a single feed: fetch it (conditionally, via the stored `ETag` /
 * `Last-Modified`), parse to JF2, and append new entries to every channel
 * following it. The feed URL is the already-resolved subscription URL, not the
 * page the user originally typed.
 */
export interface PollJob {
  readonly kind: "poll";
  /** The resolved feed URL to fetch. */
  readonly feedUrl: string;
}

/** A job on the Microsub poll queue. */
export type MicrosubJob = PollJob;
