# @dwk/log

Injectable structured-logging seam — a cross-standard reusable.

## What this is

Defines the `Logger` and `Metrics` interfaces that every `@dwk` package
consumes. Ships a `noopLogger`, a `consoleLogger` (JSON lines for Logpush), a
`withContext` wrapper (request/pod-scoped fields), and a `hostFromUrl` redaction
helper. Also ships `analyticsEngineMetrics` for Cloudflare Analytics Engine.

## Spec

`spec/packages/log.md` — authoritative requirements. Also `spec/observability.md`.

## Key constraints

- **Protocol-agnostic.** Every `@dwk` package depends on this; it must stay
  generic and free of any standard-specific logic.
- **No Cloudflare imports.** The `AnalyticsEngineDatasetLike` interface is a
  structural type, not an import.
- **Zero dependencies.** Keep it that way.
- **Injection pattern.** Packages receive a `Logger` via their config factory —
  they never construct one. This keeps the logging backend a deployer choice.

## Test environment

Node (`environment: "node"`). No Miniflare.

```bash
pnpm test --project @dwk/log
```

## File layout

```
src/index.ts       # public surface: Logger, Metrics, consoleLogger, noopLogger, withContext, hostFromUrl
src/*.test.ts      # colocated tests
```

## Depended on by

Every package except `@dwk/dpop`, `@dwk/rdf`, `@dwk/wac`, `@dwk/http-signatures`.
