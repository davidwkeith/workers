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
| `Logger`, `LogLevel`, `LogFields` | The seam types.                                           |
| `noopLogger`                 | Discards everything; the default when no logger is configured. |
| `consoleLogger(options?)`    | Emits one JSON record per call to `console` (Workers logs).    |
| `withContext(logger, ctx)`   | Binds request/pod-scoped fields onto every record.             |
| `hostFromUrl(raw)`           | Redaction helper: a URL's host only, never its path/query.     |

## Redaction

Redaction is the caller's responsibility, but the seam helps. **Never** pass
tokens, credentials, or full request/response bodies as fields. For URLs, prefer
`hostFromUrl(raw)` so an attacker-supplied path or query string never lands in a
log line.
