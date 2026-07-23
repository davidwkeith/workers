# @dwk/webmention

## 0.1.0-beta.4

### Minor Changes

- 04e16c2: Add `createWebmentionMcpTools` (#240): a read-only `@dwk/mcp` tool
  contribution `webmention_list_received`, listing verified Webmentions newest
  first (optionally scoped to a `target` URL) over the same `InboxStore` the
  queue consumer writes into. This is a new capability with no existing HTTP
  `GET` endpoint to mirror (the receiver only ever accepts `POST`), so it
  defaults `requiredScope` to `"read"` rather than an open scope. Mentions
  originate from third-party pages, so the tool description documents the
  prompt-injection surface — an agent must treat mention content as untrusted
  data, never as instructions.
- 39f6d61: Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).

### Patch Changes

- 3e505be: Queue consumers now back off exponentially (30s base, doubling per attempt,
  capped at 1h) when retrying a `message.retry()`, based on `message.attempts`.
  Previously a bare `message.retry()` re-delivered at the queue's default
  cadence indefinitely, hammering an unreachable source/feed/callback instead of
  backing off.
- Updated dependencies [0e65ce3]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Minor Changes

- 9866e8d: Recognize Indie RSVPs. During asynchronous verification, a source that carries a
  `p-rsvp` (`yes`/`no`/`maybe`/`interested`) plus a `u-in-reply-to` aimed at the
  target is detected as an RSVP and its value persisted on the inbox record (new
  nullable `rsvp` column, migrated additively on existing inboxes). Extraction is a
  bounded `HTMLRewriter` read of just those two properties — no full microformats2
  parser enters the Worker bundle. Exports `extractRsvp`, `isRsvpValue`,
  `RSVP_VALUES`, and `RsvpValue`; `VerifyResult` and `VerifiedMention` gain an
  optional `rsvp`. Part of the calendar/events work (#168).

### Patch Changes

- 6d14fc3: Fix: emit explicit `.js` extensions on relative imports so the published ESM
  packages resolve under Node's ESM loader.

  The packages were built with `moduleResolution: "Bundler"`, which let source
  files omit extensions on relative specifiers (`export { createWebmention } from
"./handler"`). `tsc` preserves specifiers verbatim, so the published
  `dist/index.js` re-exported extensionless paths that Node's ESM loader cannot
  resolve — `import("@dwk/webmention")` failed with `ERR_MODULE_NOT_FOUND` (only
  a bundler like esbuild/wrangler papered over it). Relative specifiers across the
  monorepo now carry explicit `.js` extensions, and `tsconfig.base.json` moves to
  `module`/`moduleResolution: "NodeNext"` so the compiler enforces extensions and
  this cannot silently regress.

- 22c802a: Move SSRF-safe fetch and capped body reads onto the shared `@dwk/safe-fetch`
  package instead of a package-local copy. No public API change.
- Updated dependencies [6d14fc3]
- Updated dependencies [7b86416]
- Updated dependencies [22c802a]
  - @dwk/log@0.1.0-beta.3
  - @dwk/safe-fetch@0.1.0-beta.2

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 589db69: Scan HTML with the Workers runtime's streaming `HTMLRewriter` instead of regex
  tag matching. A real tokenizer correctly ignores elements inside comments,
  handles attribute quoting, and never mistakes `data-href` for `href` — without
  pulling a parser into the bundle (`HTMLRewriter` is built into the runtime).

  Because `HTMLRewriter` is async and `workerd`-bound, the affected helpers are
  now async (and exercised under the Workers test pool rather than bare Node):
  - `@dwk/webmention`: `findWebmentionEndpoint`, `extractLinks`, and
    `sourceLinksTo` now return `Promise`s. The internal `stripComments`,
    `matchTags`, `getAttr`, and `resolveDocumentBase` regex helpers are replaced
    by a single `scanElements` primitive.
  - `@dwk/indieauth`: `parseRelMeLinks` and `relMeLinksBack` now return
    `Promise`s; the regex `rel=me` tag/attribute scanning is gone.

  Behaviour (including the webmention.rocks discovery conformance cases) is
  unchanged; only the helper signatures became async.

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.
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

- 91d6b53: Implement the Webmention receiver and sender, replacing the `501` stub.
  - **Receiver** (`createWebmention`): synchronous `source`/`target` validation
    (valid `http(s)` URLs, `source` ≠ `target`, target under the receiver's
    control), `202 Accepted`, and enqueue for async verification. Fails loudly when
    the `WEBMENTION_QUEUE` binding is missing.
  - **Async verification** (`createWebmentionQueueConsumer`): fetch the source,
    confirm it links to the target, and upsert (or remove) the mention in the
    inbox; retry on error.
  - **Sender** (`sendWebmention` / `sendWebmentions`): spec-compliant endpoint
    discovery (`Link` header → HTML `<link>`/`<a rel=webmention>`, legacy rel
    accepted, relative URLs resolved) and `source`/`target` notification.
  - **Inbox** (`createD1Inbox`): D1-backed store keyed on `(source, target)`,
    pluggable so a Solid Pod DO can back it instead.

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

- 8ab47a2: Replace fragile regexes with plain string handling where it is clearer and
  safer:
  - `@dwk/webmention`: add a shared `isHtmlContentType` helper that compares the
    `Content-Type` essence (the part before any `;` parameters) instead of a
    loose `text/html|application/xhtml+xml` substring match, and use it in both
    source verification and endpoint discovery. The `javascript:`/`file:` guard
    in the sender now compares `URL.protocol` directly rather than via regex.
  - `@dwk/solid-pod`: the access-token `typ` normalization strips the
    `application/` prefix with `startsWith`/`slice`. The LDP container `Link`
    detection now ties the `rel="type"` parameter to the container-type URI
    within the same link-value, so a stray `rel="type"` on one link can no longer
    combine with an unrelated container URI on another to falsely mark a POST as
    a container.

- abdbcbd: Tighten Webmention spec compliance on three audit follow-ups (issue #96).
  - **Exact-match non-HTML source verification (§3.2.2).** `sourceLinksTo` no
    longer treats a non-HTML body with a loose `body.includes(target)` substring
    check, which over-matched the target appearing inside a longer URL
    (`…/target/extra`), as a prefix (`…/post` inside `…/posting`), or buried in
    prose. A JSON (`application/json` or `+json`) body is now parsed and must carry
    a string value exactly equal to the target; any other body must contain the
    target as a standalone URL token (boundary-checked), not a bare substring. The
    HTML path already did proper resolved-link exact matching.
  - **Robust legacy `rel` matching (sender discovery).** Endpoint discovery matched
    the legacy rel with `startsWith("http://webmention.org")`, which also accepted
    look-alike hosts like `http://webmention.org.evil.example/`. It now normalizes a
    candidate rel through `URL` and compares against the canonical legacy endpoints
    `http://webmention.org/` and `http://webmention.org/webmention` — so a
    look-alike host (or wrong scheme) is rejected, while a commonly omitted trailing
    slash (`http://webmention.org`) still matches.
  - **Receiver `Content-Type` validation (§3.1.3).** The receiver now requires an
    `application/x-www-form-urlencoded` body and rejects other encodings (e.g.
    `multipart/form-data`) with `400` instead of accepting whatever
    `Request.formData()` parses.

  The deleted-source (HTTP 410) re-send on the sender (§3.1.5, a SHOULD) remains an
  intentional scope limit and is now recorded as a known conformance gap in the
  package spec; the receiver already drops a mention when re-verification finds the
  link gone.

- e16e751: Harden every outbound fetch against SSRF. Source verification, endpoint
  discovery, and sender notification now route through a shared `safeFetch`
  wrapper that rejects private/loopback/link-local/reserved hosts (including the
  `169.254.169.254` cloud metadata IP, IPv4-mapped IPv6, and names like
  `localhost`/`*.internal`), follows redirects manually while re-validating the
  host on every hop and capping the hop count, and bounds the whole request with
  a timeout. Exports `safeFetch`, `assertPublicUrl`, `isPrivateOrReservedHost`,
  and `SsrfError`.
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
