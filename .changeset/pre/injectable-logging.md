---
"@dwk/log": minor
"@dwk/webmention": minor
---

Add `@dwk/log`, an injectable structured-logging seam, and wire `@dwk/webmention`
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
