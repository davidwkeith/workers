# @dwk/log

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.

## 0.1.0-beta.0

### Minor Changes

- 78f1a6f: Add `@dwk/log`, an injectable structured-logging seam, and wire `@dwk/webmention`
  as its first consumer.
  - **`@dwk/log`** (new, cross-standard reusable lib): a minimal `Logger`
    interface (`debug`/`info`/`warn`/`error`, taking a stable dotted event name +
    structured fields), a `noopLogger` default, a `consoleLogger` that emits one
    JSON record per call for Workers structured logs, `withContext` for binding
    request/pod-scoped fields, and a `hostFromUrl` redaction helper. Protocol-
    agnostic, no Workers runtime dependency.
  - **`@dwk/webmention`**: `WebmentionConfig`, `VerifyOptions`, `DiscoverOptions`,
    `SendOptions`, and `SafeFetchOptions` now accept an optional `logger`
    (defaulting to a no-op). The package now logs the security-relevant events
    that were previously swallowed: SSRF blocks (`webmention.ssrf.blocked`, with a
    machine-readable reason + sanitized host), verification outcomes, send
    outcomes, receiver accept/reject, and — crucially — queue-consumer retry
    reasons (`webmention.queue.retry`) so a poison message no longer retries
    silently. `SsrfError` now carries structured `reason`/`host` fields, and the
    event taxonomy is exported as `WebmentionLogEvent`.

- 6963674: Add an injectable **metrics** seam to `@dwk/log` (companion to `Logger`) with an
  Analytics Engine adapter, and wire `@dwk/webmention` as its first consumer.
  - **`@dwk/log`**: a minimal `Metrics` interface (`count(event, fields?)` /
    `observe(event, value, fields?)`) that reuses the same event taxonomy and
    field bags as `Logger`, a `noopMetrics` default, and
    `analyticsEngineMetrics(dataset, options?)` — an adapter that maps each call
    onto Cloudflare Workers Analytics Engine `writeDataPoint` (event →
    `indexes[0]` + `blobs[0]`, string fields → `blobs`, numeric/boolean fields →
    `doubles`, in sorted key order so positions are stable per event). It enforces
    the AE limits (1 index ≤ 96 B, ≤ 20 blobs ≤ 16 KB total, ≤ 20 doubles), never
    throws into the measured operation, and targets the binding through a
    structural type (`AnalyticsEngineDatasetLike`) so the library keeps no
    `@cloudflare/workers-types` dependency. Injected exactly like `logger` —
    optional, defaulting to a no-op — as two independent seams, not one combined
    `Observer`.
  - **`@dwk/webmention`**: `WebmentionConfig`, `VerifyOptions`, `DiscoverOptions`,
    `SendOptions`, and `SafeFetchOptions` now accept an optional `metrics`
    (defaulting to a no-op). The package emits counters mirroring its log events
    on the shared `WebmentionLogEvent` vocabulary: SSRF blocks (by reason),
    receive accepted/rejected, verification outcomes (by links/status), queue
    retries (by reason), and send outcomes (by delivered/status), so an operator
    can chart them rather than scraping log lines.

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.
