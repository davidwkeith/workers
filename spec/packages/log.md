# `@dwk/log`

| | |
|---|---|
| **Type** | lib (cross-standard reusable) |
| **Ships a DO?** | no |
| **Used by** | every `@dwk` package that emits logs (first: [`@dwk/webmention`](webmention.md)) |

A minimal, **injectable** structured-logging seam. A **cross-standard
reusable**: like [`@dwk/dpop`](dpop.md) and [`@dwk/rdf`](rdf.md), it MUST stay
free of IndieWeb/Solid assumptions so future `@dwk` standards adopt it
unchanged. See [observability.md](../observability.md) for the cross-cutting
requirement this package implements.

## Functional requirements

- Define a `Logger` interface: `debug` / `info` / `warn` / `error`, each taking
  a stable, dotted **event name** and an optional flat bag of structured
  **fields**. Implementations MUST NOT throw — a logging failure must never break
  the operation being logged.
- Provide a **`noopLogger`** that discards everything; this is the default a
  package uses when its config supplies none, so logging is strictly opt-in.
- Provide a **`consoleLogger`** that emits one JSON record per call
  (`{ ...base, ...fields, level, event, time }` — the envelope spread last, so
  a caller field named `level`/`event`/`time` can never clobber it) to
  `console`, suitable for Cloudflare Workers structured logs / Logpush. It MUST
  support a minimum-level threshold and base fields.
- Provide **`withContext`** to bind request-/pod-scoped fields onto every record
  at the composition boundary.
- Provide a **redaction helper** (`hostFromUrl`) returning a URL's host only, so
  attacker-supplied paths/queries never reach a log line.

## Design constraints

- **Plain-data inputs only**, no I/O of its own by default, no state. It MUST
  unit-test **without a Workers runtime** (Node environment).
- **Protocol-agnostic:** no IndieWeb-/Solid-specific events baked in. Event-name
  taxonomies are owned by each consuming package.
- **ESM-only**, tree-shakeable, fully typed, dependencies minimized (none).

## Testing

- Unit tests under Node: no-op is silent; `consoleLogger` serialization, level
  filtering, base/field merge, and `undefined`-field omission; `withContext`
  merge precedence; `hostFromUrl` host extraction and parse failure.
