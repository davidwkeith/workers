# `@dwk/log`

Minimal, injectable structured-logging seam shared across the `@dwk` packages.

A **cross-standard reusable lib** (like [`@dwk/dpop`](../dpop) and
[`@dwk/rdf`](../rdf)): protocol-agnostic, stateless, and unit-testable without a
Workers runtime. It defines _where_ the `@dwk` packages send signal, not _how_
that signal is stored — the composed Worker wires a concrete logger to Workers
structured logs / Logpush / Analytics Engine.

See [`spec/observability.md`](../../spec/observability.md) for the cross-cutting
requirement and the event-taxonomy conventions.

## Why

The `@dwk` packages handle untrusted, attacker-supplied input. Without a logging
seam, security-relevant events — a blocked SSRF attempt, an auth rejection, a
poison queue message — are silently swallowed and indistinguishable from a dead
link or a timeout. This package is the seam those events flow through.

## The seam

```ts
import type { Logger } from "@dwk/log";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
```

Each call names a **stable, dotted event** (e.g. `webmention.ssrf.blocked`) plus
a flat bag of structured fields, so operators query by event and field instead
of grepping prose. Event-name taxonomies are owned by each consuming package.

## Usage

A package accepts an **optional** `logger` in its config and defaults to
`noopLogger`, so logging is strictly opt-in:

```ts
import { noopLogger, type Logger } from "@dwk/log";

function createThing(config: { logger?: Logger }) {
  const logger = config.logger ?? noopLogger;
  logger.warn("thing.blocked", { reason: "policy" });
}
```

The composed Worker wires a real logger once:

```ts
import { consoleLogger } from "@dwk/log";

const logger = consoleLogger({ minLevel: "info", base: { service: "wm" } });
const handler = createWebmention({ baseUrl, logger });
```

### Exports

| Export                       | Purpose                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `Logger`, `LogLevel`, `LogFields` | The logging seam types.                                  |
| `noopLogger`                 | Discards everything; the default when no logger is configured. |
| `consoleLogger(options?)`    | Emits one JSON record per call to `console` (Workers logs).    |
| `withContext(logger, ctx)`   | Binds request/pod-scoped fields onto every record.             |
| `hostFromUrl(raw)`           | Redaction helper: a URL's host only, never its path/query.     |
| `Metrics`                    | The metrics seam type (`count` / `observe`).                   |
| `noopMetrics`                | Discards everything; the default when no metrics sink is set.  |
| `analyticsEngineMetrics(dataset, options?)` | Adapter to Cloudflare Workers Analytics Engine. |

## Metrics

The companion **metrics** seam answers "how often / how much?" for the same
events the logger names, so an operator can chart "SSRF blocks/min" or
"verification success rate" instead of scraping log lines. It is injected the
same way — an **optional** `metrics`, defaulting to `noopMetrics` — and reuses
the same event names and field bags as logs, so logs and counters share one
vocabulary:

```ts
import { noopMetrics, type Metrics } from "@dwk/log";

function createThing(config: { metrics?: Metrics }) {
  const metrics = config.metrics ?? noopMetrics;
  metrics.count("thing.blocked", { reason: "policy" }); // a counter
  metrics.observe("thing.latency", 42, { host: "a.example" }); // an observation
}
```

The composed Worker wires the real adapter once, from a bound
`AnalyticsEngineDataset`:

```ts
import { analyticsEngineMetrics } from "@dwk/log";

// env.WM_METRICS is an AnalyticsEngineDataset binding declared in wrangler.toml.
const metrics = analyticsEngineMetrics(env.WM_METRICS, {
  base: { service: "wm" },
});
const handler = createWebmention({ baseUrl, logger, metrics });
```

`analyticsEngineMetrics` maps each call onto `writeDataPoint` deterministically:
the `event` becomes `indexes[0]` (the sampling key) and `blobs[0]`; string fields
become further `blobs`, and numeric/boolean fields become `doubles` (with a lead
`1` for `count` or the observed value for `observe`) — all in sorted key order so
positions are stable per event. Cloudflare's Analytics Engine limits (1 index ≤
96 B, ≤ 20 blobs ≤ 16 KB total, ≤ 20 doubles) are enforced, and like `Logger` a
`Metrics` implementation **never throws** into the operation it measures. The
binding type is declared structurally (`AnalyticsEngineDatasetLike`), so this
package keeps no `@cloudflare/workers-types` dependency. The same redaction rules
apply — never pass tokens, bodies, or full URLs as fields.

## Redaction

Redaction is the caller's responsibility, but the seam helps. **Never** pass
tokens, credentials, or full request/response bodies as fields. For URLs, prefer
`hostFromUrl(raw)` so an attacker-supplied path or query string never lands in a
log line.
