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

## The injectable metrics seam

Logs answer "what happened?"; **metrics** answer "how often / how much?" — so an
operator can chart "SSRF blocks/min", "verification success rate", or "queue
retries by reason" rather than scraping log lines. Metrics follow the **same
injection discipline** as logging.

- Packages MUST NOT reach for a global metrics client or read the environment
  for one. A package's config/options accepts an **optional** `metrics`,
  defaulting to a **no-op** (`noopMetrics`), exactly like `logger`.
- The seam is the small `Metrics` interface in [`@dwk/log`](../packages/log) —
  `count(event, fields?)` and `observe(event, value, fields?)`. It is a
  **cross-standard reusable** alongside `Logger`: protocol-agnostic, no
  Workers-runtime dependency.
- Metrics **reuse the same event taxonomy and field bags as logs** (e.g.
  `WebmentionLogEvent`), so a log line and its counter share one vocabulary: the
  same `(event, fields)` is passed to both seams.
- The composed Worker wires a concrete adapter **once** at the composition
  boundary. `@dwk/log` ships `analyticsEngineMetrics(dataset)`, targeting
  [Cloudflare Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
  through a **structural** binding type so the library stays Cloudflare-free
  (the same trick `consoleLogger` uses for `console`).
- Two **independent** optional injectables (`logger`, `metrics`), not one
  combined `Observer`, so each seam stays minimal and independently testable.
- **Counters first.** `count` is the first-class operation; `observe` exists for
  later durations/histograms (e.g. fetch latency) and is not yet a first
  consumer.

### Analytics Engine field mapping

`analyticsEngineMetrics` maps each call onto `writeDataPoint` deterministically,
so positions are stable per event:

- **`indexes[0]`** = the `event` name — the queryable **sampling key** (one
  index only, truncated to 96 bytes).
- **`blobs`** = `[event, …string-valued fields]`, fields in **sorted key
  order**.
- **`doubles`** = `[lead, …number/boolean fields]` in sorted key order, where
  `lead` is `1` for `count` or the observed value for `observe`, and booleans
  map to `1`/`0`.

Non-scalar fields and `undefined`/`null`/non-finite numbers are dropped. Because
field positions follow sorted key order, an event SHOULD carry a **stable field
shape** so `blobN` / `doubleN` mean the same thing across data points. AE limits
are respected: ≤ 1 index (96 B), ≤ 20 blobs (≤ 16 KB total), ≤ 20 doubles. A
failing `writeDataPoint` is swallowed — like `Logger`, **`Metrics` MUST NOT
throw** into the operation being measured.

The **redaction policy below applies identically to metrics**: only hosts,
ports, status, reason/result codes, booleans, and counts become data points —
never tokens, bodies, or full URLs.

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

- **Structured logs and counters.** Both seams ship: structured logs (`Logger`)
  and metrics counters (`Metrics`, with the Analytics Engine adapter). Durations
  and histograms via `observe` are available but not yet a first consumer.
- **First consumer:** `@dwk/webmention` emits, on **both** seams, the same
  events — SSRF blocks (by reason), receive accepted/rejected, verification
  outcomes (by links/status), queue-consumer retry reasons, and send outcomes
  (by delivered/status).
- **All endpoint packages except `@dwk/webdav` emit on both seams.** Each owns
  an exported event taxonomy (a `*LogEvent` vocabulary, typically in `src/log.ts`)
  and passes the same `(event, fields)` to logger and metrics. `@dwk/webdav` has
  no observability seam yet — a known gap to close, not an exemption. The
  representative examples (not an exhaustive list):
  - `@dwk/indieauth` (`IndieAuthLogEvent`): authorization rejections (by
    reason), code issuance, token issuance, token-endpoint rejections (by
    reason), and revocations.
  - `@dwk/micropub` (`MicropubLogEvent`): authorization rejections (by error
    code), validation rejections (by reason), action completions (by verb), and
    media stored.
  - `@dwk/solid-pod` (`SolidPodLogEvent`): edge-authentication rejections (by
    reason) and acceptances. Because a Durable Object cannot receive the injected
    seams across the isolate boundary, the DO signals its WAC denials,
    anonymous-write refusals, and DPoP replay rejections back to the stateless
    front door via an internal response header (`x-solid-outcome`); the front
    door — where the seams are wired, at the composition boundary — emits the
    events and strips the header before replying.
  - `@dwk/activitypub` (`ActivityPubLogEvent`): signature
    rejections/acceptances and publish rejections emit directly at the front
    door; inbound inbox outcomes use the same request-scoped internal-header
    relay as `@dwk/solid-pod` (`x-ap-outcome`). **Alarm-driven work** (the
    DO's outbound delivery queue) has no HTTP response to relay through, so
    its outcomes split by seam: the log line goes straight to `console` from
    the DO (a reasonable escape hatch — `wrangler tail` reads `console`
    regardless of any seam), while the matching **counter delta** accumulates
    durably in the DO's SQLite, coalesced by `(event, fields)`, and is drained
    on the next front-door-forwarded request via an internal response header
    (`x-ap-metrics`, requested with `x-ap-metrics-drain`). The front door
    replays each delta into the injected `Metrics` (one `count` per
    occurrence; log lines are NOT re-emitted — they already fired in the DO)
    and strips the header. Counters are delay-tolerant aggregates, so riding
    the next request loses nothing an operator charts; drains are bounded per
    response, and the pending table is cardinality-capped, overflowing into a
    dedicated `activitypub.metrics.overflow` counter rather than losing counts
    silently. This is the template for any future DO that must report metrics
    for its own alarm-driven work.
