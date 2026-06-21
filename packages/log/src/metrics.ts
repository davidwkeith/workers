/**
 * `@dwk/log` — a minimal, injectable **metrics** seam, companion to {@link Logger}.
 *
 * Where the {@link Logger} answers "what happened?" with one structured record
 * per event, this seam answers "how often / how much?" — emitting queryable
 * counters and observations so an operator can chart "SSRF blocks/min",
 * "verification success rate", or "queue retries by reason" rather than scraping
 * log lines. It mirrors the logging seam exactly: a package takes an **optional**
 * {@link Metrics} in its config, defaulting to {@link noopMetrics}, and the
 * composed Worker wires a concrete adapter **once** at the composition boundary.
 * It does **no I/O of its own by default**.
 *
 * Like the rest of `@dwk/log` it is a **cross-standard reusable**: protocol-
 * agnostic, holding no IndieWeb/Solid assumptions, with no Workers-runtime
 * dependency. The {@link analyticsEngineMetrics} adapter targets Cloudflare
 * Workers Analytics Engine through a **structural** binding type
 * ({@link AnalyticsEngineDatasetLike}) — the same trick {@link ConsoleLike} uses
 * for `console` — so this library never imports `@cloudflare/workers-types` and
 * still unit-tests under plain Node.
 *
 * Metrics reuse the same **event taxonomy** and the same {@link LogFields} bags
 * as logs, so logs and metrics share one vocabulary: pass the same
 * `(event, fields)` to both seams. The **redaction policy is identical** — only
 * hosts, ports, status, machine-readable reason/result codes, booleans, and
 * counts; never tokens, bodies, or full URLs (use {@link hostFromUrl}).
 *
 * @see spec/observability.md
 * @packageDocumentation
 */

import type { LogFields } from "./index.js";

/**
 * The metrics seam every `@dwk` package writes to, alongside {@link Logger}.
 *
 * Both methods name the same stable, dotted `event` as the logger and an
 * optional bag of structured {@link LogFields} — the adapter turns string fields
 * into queryable dimensions and numeric/boolean fields into measurements.
 * Implementations MUST NOT throw — a metrics failure must never break the
 * operation being measured.
 */
export interface Metrics {
  /**
   * Record one occurrence of `event` (a counter increment of 1). Use for
   * tallies like "SSRF blocks", "mentions received", "retries".
   */
  count(event: string, fields?: LogFields): void;
  /**
   * Record a numeric observation of `value` for `event` (a gauge/histogram
   * sample). Use for measurements like a fetch latency in milliseconds.
   */
  observe(event: string, value: number, fields?: LogFields): void;
}

/**
 * A metrics sink that discards everything. This is the default a package uses
 * when its config supplies none, so metrics are strictly opt-in and pure libs
 * stay side-effect-free in tests.
 */
export const noopMetrics: Metrics = {
  count: () => {},
  observe: () => {},
};

/**
 * One Analytics Engine data point. A structural mirror of Cloudflare's
 * `AnalyticsEngineDataPoint` so this library needs no `@cloudflare/workers-types`
 * dependency; the real binding is assignable to it.
 */
export interface AnalyticsEngineDataPoint {
  /** Up to one sampling key, each ≤ 96 bytes. */
  indexes?: (ArrayBuffer | string | null)[];
  /** Up to 20 string/blob dimensions; total size ≤ 16 KB. */
  blobs?: (ArrayBuffer | string | null)[];
  /** Up to 20 numeric measurements. */
  doubles?: number[];
}

/**
 * The slice of a Cloudflare `AnalyticsEngineDataset` binding that
 * {@link analyticsEngineMetrics} writes to. Declared structurally (like
 * {@link ConsoleLike}) so a test can pass a spy and the composed Worker can pass
 * the real `env.<DATASET>` binding.
 */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point?: AnalyticsEngineDataPoint): void;
}

/** Tunables for {@link analyticsEngineMetrics}. */
export interface AnalyticsEngineMetricsOptions {
  /**
   * Fields merged into every data point (e.g. a deployment id or service name),
   * mapped to blobs/doubles like any other field. Per-call fields win on a key
   * collision.
   */
  readonly base?: LogFields;
}

/** Analytics Engine limits (see the Workers Analytics Engine docs). */
const MAX_INDEX_BYTES = 96;
const MAX_BLOBS = 20;
const MAX_DOUBLES = 20;
const MAX_BLOB_BYTES_TOTAL = 16_384;

const utf8 = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

/** Truncate `value` to at most `maxBytes` UTF-8 bytes, on a char boundary. */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = utf8.encode(value);
  if (bytes.length <= maxBytes) {
    return value;
  }
  // Find the boundary by inspecting the bytes rather than decoding a partial
  // slice: that way we never emit U+FFFD for a split char (and never mistake a
  // genuine trailing U+FFFD in the input for one). First back off any
  // continuation bytes (0b10xxxxxx) sitting at the cut...
  let len = maxBytes;
  while (len > 0 && ((bytes[len - 1] ?? 0) & 0xc0) === 0x80) {
    len--;
  }
  // ...then, if we're left just after a lead byte whose multibyte sequence the
  // cut would split, drop that lead byte too; otherwise the whole sequence fit,
  // so keep up to maxBytes.
  const lead = bytes[len - 1] ?? 0;
  if (len > 0 && lead >= 0xc0) {
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    len = len - 1 + seqLen > maxBytes ? len - 1 : maxBytes;
  }
  // subarray is a zero-copy view (unlike slice), and the bytes are now a whole
  // number of UTF-8 sequences, so the decode is exact.
  return new TextDecoder().decode(bytes.subarray(0, len));
}

/** Cap a blob list to AE's count and total-byte limits, truncating the last. */
function capBlobs(blobs: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const blob of blobs) {
    if (out.length >= MAX_BLOBS) {
      break;
    }
    const bytes = utf8ByteLength(blob);
    if (total + bytes <= MAX_BLOB_BYTES_TOTAL) {
      out.push(blob);
      total += bytes;
      continue;
    }
    const remaining = MAX_BLOB_BYTES_TOTAL - total;
    if (remaining > 0) {
      out.push(truncateUtf8(blob, remaining));
    }
    break;
  }
  return out;
}

/**
 * A {@link Metrics} adapter that writes each call to a Cloudflare Workers
 * Analytics Engine dataset via `writeDataPoint`.
 *
 * **Field mapping (deterministic, so positions are stable per event):**
 * - `indexes[0]` = the `event` name (the sampling key; truncated to 96 bytes).
 * - `blobs` = `[event, …string-valued fields]`, fields in **sorted key order**.
 * - `doubles` = `[lead, …number/boolean fields]` in sorted key order, where
 *   `lead` is `1` for {@link Metrics.count} or the observed value for
 *   {@link Metrics.observe}, and booleans map to `1`/`0`.
 *
 * Non-scalar fields (objects, arrays) and `undefined`/`null`/non-finite numbers
 * are dropped — metric fields must be scalar and safe to record. Because field
 * positions follow sorted key order, an event SHOULD carry a stable field shape
 * so `blobN` / `doubleN` mean the same thing across data points.
 *
 * Honors the {@link Metrics} non-throwing contract: a failing `writeDataPoint`
 * is swallowed rather than thrown into the operation being measured.
 */
export function analyticsEngineMetrics(
  dataset: AnalyticsEngineDatasetLike,
  options: AnalyticsEngineMetricsOptions = {},
): Metrics {
  const base = options.base;

  const write = (event: string, lead: number, fields?: LogFields): void => {
    const merged: LogFields = { ...base, ...fields };
    const blobs: string[] = [event];
    const doubles: number[] = [lead];
    for (const key of Object.keys(merged).sort()) {
      const value = merged[key];
      if (typeof value === "string") {
        blobs.push(value);
      } else if (typeof value === "boolean") {
        doubles.push(value ? 1 : 0);
      } else if (typeof value === "number" && Number.isFinite(value)) {
        doubles.push(value);
      }
      // Anything else (undefined, null, objects, NaN, …) is intentionally
      // dropped: metric fields must be scalar and safe to record.
    }
    try {
      dataset.writeDataPoint({
        indexes: [truncateUtf8(event, MAX_INDEX_BYTES)],
        blobs: capBlobs(blobs),
        doubles: doubles.slice(0, MAX_DOUBLES),
      });
    } catch {
      // Metrics MUST NOT throw: a failed write must never break the operation
      // being measured. There is no fallback sink, so swallow it.
    }
  };

  return {
    count: (event, fields) => write(event, 1, fields),
    observe: (event, value, fields) =>
      write(event, Number.isFinite(value) ? value : 0, fields),
  };
}
