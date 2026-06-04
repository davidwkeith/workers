# Observability (cross-cutting)

The `@dwk` packages handle untrusted, attacker-supplied input. A failure or a
security-relevant event that is silently swallowed is an operational blind spot:
an operator being actively probed (e.g. a `source` pointing at
`http://169.254.169.254/…`) would never know. This document defines the
cross-cutting **observability** requirement and the conventions that keep logs
queryable.

It complements [composition-contract.md](composition-contract.md) (injected
config, no global-env reads) and
[non-functional-requirements.md](non-functional-requirements.md).

## The injectable logging seam

- Packages MUST NOT reach for a global logger or read the environment for one.
  Logging is injected the same way `fetch` is: a package's config/options
  accepts an **optional** `logger`, defaulting to a **no-op**.
- The seam is the small `Logger` interface in
  [`@dwk/log`](../packages/log) — `debug` / `info` / `warn` / `error`, each
  taking a stable **event name** plus a flat bag of structured **fields**. It is
  a **cross-standard reusable** (like `@dwk/dpop` / `@dwk/rdf`): protocol-
  agnostic, so every `@dwk` standard adopts it unchanged.
- Pure libs (`@dwk/dpop`, `@dwk/rdf`, `@dwk/wac`) stay runtime-agnostic and
  unit-test with the no-op (or a capturing stub) logger. The composed Worker
  wires a concrete logger (`consoleLogger`, or an adapter to Logpush / Analytics
  Engine) **once** at the composition boundary.

## Structured events, not free text

- Every log call MUST name a **stable, dotted event** of the form
  `<package>.<area>.<outcome>` (e.g. `webmention.ssrf.blocked`,
  `webmention.queue.retry`), so operators query by event and field rather than
  grepping prose.
- Each package **owns its event taxonomy** (exported as a constant — see
  `WebmentionLogEvent`), so the set of events is discoverable and stable.
- **Security-relevant events are first-class:** a blocked SSRF attempt (with its
  reason and sanitized host), auth/authz rejections, and validation rejections
  SHOULD each emit a distinct event so they are never indistinguishable from a
  dead link or a timeout.

## Severity

| Level   | Use for                                                              |
| ------- | ------------------------------------------------------------------- |
| `debug` | Verbose developer detail; off in production by default.             |
| `info`  | Normal, noteworthy outcomes (a verification completed, a send done).|
| `warn`  | Handled-but-notable events: **a blocked SSRF attempt**, a retry, a validation rejection. |
| `error` | A failure needing attention.                                        |

## Redaction policy

Redaction is the caller's responsibility, but the seam helps.

- **Never log** tokens, credentials, cookies, `Authorization` headers, or full
  request/response bodies.
- **Safe to log:** hosts, ports, HTTP status, machine-readable reason/result
  codes, booleans, counts.
- For URLs, log **only the host** via `hostFromUrl` — an attacker-supplied path
  or query string MUST NOT land in a log line.

## Scope (current)

- **Structured logs first.** Metrics/counters (e.g. Analytics Engine) are a
  separate, later concern and are intentionally out of scope here; the same
  injected seam can host a metrics adapter when needed.
- **First consumer:** `@dwk/webmention` (SSRF blocks, verification outcomes,
  queue-consumer retry reasons). The other endpoint packages
  (`@dwk/indieauth`, `@dwk/micropub`, `@dwk/solid-pod`) adopt the same seam for
  auth/authz decisions and validation rejections as they are implemented.
