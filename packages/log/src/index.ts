/**
 * `@dwk/log` — a minimal, injectable structured-logging seam.
 *
 * The `@dwk` packages handle untrusted, attacker-supplied input, so failures and
 * security-relevant events (a blocked SSRF attempt, an auth rejection) must
 * produce a signal rather than being silently swallowed. This library defines
 * the seam that signal flows through. It deliberately does **no I/O of its own
 * by default**: a package takes an optional {@link Logger} in its config and
 * calls it; the composed Worker decides where the records actually go (Workers
 * structured logs, Logpush, Analytics Engine, …) by wiring in a concrete logger.
 *
 * It is a **cross-standard reusable**: like `@dwk/dpop` and `@dwk/rdf`, it MUST
 * stay free of IndieWeb/Solid assumptions so future `@dwk` standards adopt it
 * unchanged. It holds no state, performs no protocol logic, and unit-tests
 * without a Workers runtime.
 *
 * Logs are **structured events**, not free text: every call names a stable,
 * dotted `event` (e.g. `webmention.ssrf.blocked`) plus a flat bag of fields, so
 * an operator can query by event and field rather than grep prose. Event-name
 * taxonomies are owned by each consuming package, not by this library.
 *
 * **Redaction is the caller's responsibility, but the seam helps:** never pass
 * tokens, credentials, or full request/response bodies as fields. For URLs,
 * prefer {@link hostFromUrl} so an attacker-supplied path/query never lands in a
 * log line.
 *
 * Logs answer "what happened?"; the companion {@link Metrics} seam (same file
 * family, same injection discipline) answers "how often / how much?" for the
 * same events. See {@link ./metrics}.
 *
 * @see spec/observability.md
 * @see spec/packages/log.md
 * @packageDocumentation
 */

export {
  type Metrics,
  noopMetrics,
  analyticsEngineMetrics,
  type AnalyticsEngineDatasetLike,
  type AnalyticsEngineDataPoint,
  type AnalyticsEngineMetricsOptions,
} from "./metrics.js";

/** Severity of a log record, in increasing order of importance. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * A flat bag of structured fields attached to a log record. Keys SHOULD be
 * stable and queryable; values MUST be safe to record (no secrets, no bodies).
 */
export type LogFields = Record<string, unknown>;

/**
 * The logging seam every `@dwk` package writes to.
 *
 * Each method takes a stable, dotted `event` name and an optional bag of
 * structured `fields`. Implementations MUST NOT throw — a logging failure must
 * never break the operation being logged.
 */
export interface Logger {
  /** Verbose, developer-facing detail; off in production by default. */
  debug(event: string, fields?: LogFields): void;
  /** A normal, noteworthy outcome (e.g. a verification completed). */
  info(event: string, fields?: LogFields): void;
  /** A handled-but-notable event (e.g. a blocked SSRF attempt, a retry). */
  warn(event: string, fields?: LogFields): void;
  /** A failure that needs attention. */
  error(event: string, fields?: LogFields): void;
}

/**
 * A logger that discards everything. This is the default a package uses when
 * its config supplies none, so logging is strictly opt-in and pure libs stay
 * silent and side-effect-free in tests.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Numeric ordering of {@link LogLevel} used for threshold filtering. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * The slice of the global `console` (or any compatible sink) that
 * {@link consoleLogger} writes to. Declared structurally so a test can pass a
 * spy and the composed Worker can pass `console`.
 */
export interface ConsoleLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Tunables for {@link consoleLogger}. */
export interface ConsoleLoggerOptions {
  /** Sink to write to; defaults to the global `console`. */
  readonly console?: ConsoleLike;
  /** Drop records below this level (default `"debug"`, i.e. emit everything). */
  readonly minLevel?: LogLevel;
  /** Fields merged into every record (e.g. a deployment or request id). */
  readonly base?: LogFields;
  /** Timestamp source, for deterministic tests (default `Date.now` as ISO). */
  readonly now?: () => string;
}

/**
 * A {@link Logger} that emits one JSON object per record to `console`, suitable
 * for Cloudflare Workers structured logs / Logpush.
 *
 * Each record is `{ level, event, time, ...base, ...fields }`, serialized with
 * `JSON.stringify` (which drops `undefined`-valued fields, so optional context
 * can be passed unconditionally). Records below `minLevel` are dropped. The
 * matching `console` method is used per level so a platform's level routing
 * still applies.
 *
 * Honors the {@link Logger} non-throwing contract: if a field is not
 * JSON-serializable (a circular reference, a `BigInt`, …) the record is replaced
 * by a minimal `log.serialization_failed` record rather than throwing into the
 * operation being logged.
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const sink = options.console ?? console;
  const threshold = LEVEL_ORDER[options.minLevel ?? "debug"];
  const now = options.now ?? (() => new Date().toISOString());
  const base = options.base;

  const emit =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < threshold) {
        return;
      }
      const record: LogFields = {
        level,
        event,
        time: now(),
        ...base,
        ...fields,
      };
      try {
        sink[level](JSON.stringify(record));
      } catch (err) {
        // Honor the Logger "MUST NOT throw" contract: a non-serializable field
        // (circular reference, BigInt, …) must never break the operation being
        // logged. Fall back to a minimal, guaranteed-serializable record. The
        // serializer's own error message is safe to log — it is not caller data.
        sink.error(
          JSON.stringify({
            level: "error",
            event: "log.serialization_failed",
            time: record.time,
            failedEvent: event,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

/**
 * Wrap `logger` so that `context` is merged into the fields of every record.
 *
 * Use this to bind request- or pod-scoped context (a request id, a pod id) once
 * at the composition boundary instead of repeating it at every call site. The
 * per-call `fields` win on key collisions.
 */
export function withContext(logger: Logger, context: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields => ({ ...context, ...fields });
  return {
    debug: (event, fields) => logger.debug(event, merge(fields)),
    info: (event, fields) => logger.info(event, merge(fields)),
    warn: (event, fields) => logger.warn(event, merge(fields)),
    error: (event, fields) => logger.error(event, merge(fields)),
  };
}

/**
 * Extract just the host from a URL string, for safe logging.
 *
 * Returns the `host` (name plus any non-default port) and nothing else — no
 * scheme, path, query, or userinfo — so an attacker-supplied `source`/`target`
 * URL never lands in a log line in full. Returns `undefined` when `raw` is not a
 * parseable URL.
 */
export function hostFromUrl(raw: string): string | undefined {
  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
}
