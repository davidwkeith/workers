# @dwk/websub

## 0.1.0-beta.4

### Minor Changes

- 39f6d61: Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).
- 2de1ea6: Distribute content per-subscriber instead of in one unbounded fan-out. A
  publish now enqueues a `distribute` job that fetches the topic snapshot once and
  plans the fan-out: it enqueues one `deliver` job per active subscriber, each of
  which POSTs to a single callback and retries on its own queue checkpoint. This
  fixes three problems with the previous once-only `Promise.all` fan-out: a
  subscriber down during a publish no longer silently misses the update; a large
  subscriber set no longer exceeds a single invocation's subrequest ceiling; and a
  transient failure no longer re-delivers to every subscriber (duplicates).

  Small snapshots ride inline in each `deliver` message, **base64-encoded** (a raw
  `Uint8Array` would be JSON-serialized by Cloudflare Queues into a ~10×-larger
  `{"0":…}` byte map and not round-trip as bytes). A body too large to inline
  (> `MAX_INLINE_BODY_BYTES`, 64 KB raw) is staged once in a new optional
  `WEBSUB_CONTENT` R2 bucket and referenced by key. When a snapshot exceeds the
  inline limit and no bucket is configured, the fan-out fails loudly rather than
  truncating the push. Delivery is at-least-once: a `distribute` retry after a
  partial `sendBatch` fan-out can re-enqueue deliver jobs for subscribers already
  reached (WebSub §7 requires subscribers to tolerate duplicates).
  `deliverToSubscriber` now accepts the narrower `DeliveryTarget` shape
  (`Subscription` remains assignable).

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

### Patch Changes

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

- 4c4ad6c: Add `@dwk/websub`, a WebSub (W3C) hub — the publish-side, real-time complement
  to `@dwk/webmention`.
  - **Hub endpoint** (`createWebSub`): a `POST`-only handler, mountable under any
    prefix, that validates `hub.mode=subscribe|unsubscribe` requests
    (`hub.callback`/`hub.topic`/`hub.lease_seconds`/`hub.secret`) and publish pings
    synchronously, enqueues the slow work, and returns `202`. Fails loudly when the
    `WEBSUB_QUEUE` binding is missing.
  - **Subscription store** (`createD1SubscriptionStore`): D1-backed (strongly
    consistent — never KV), keyed on `(callback, topic)`, with lease expiry,
    active-lease listing, and expired-lease pruning.
  - **Queue consumer** (`createWebSubQueueConsumer`): verification-of-intent GET
    with `hub.challenge` echo (a subscription is written only after it confirms),
    and content distribution — fetch the topic and fan it out to active
    subscribers, HMAC-SHA256 signing the body (`X-Hub-Signature`) when a secret is
    registered. Retries on store/topic failure.
  - **Publish notifier** (`createPublishNotifier`): an in-process entry point for
    the Micropub write / Anglesite rebuild path.
  - All outbound requests (verification GET, distribution POST) go through an
    SSRF-safe `fetch` with per-hop host re-validation and a timeout. Lease math,
    validation, verification, and signing are pure and unit-tested without a
    Workers runtime.

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

- 44e82b5: Make the `X-Hub-Signature` digest method configurable on the hub. WebSub §7.1
  permits `sha1|sha256|sha384|sha512`; the hub previously hard-coded SHA-256 with
  no way to interoperate with subscribers expecting another method. A new
  `signatureAlgorithm` config option (default `sha256`, the secure choice) lets a
  deployment opt into SHA-1 for legacy-subscriber interop, and the distribution
  signature is emitted as `<method>=<hex>` for the configured method.
- d50dae3: Address three WebSub spec-compliance follow-ups (#94).
  - **Subscription-denial callback (WebSub §5.2).** When intent verification of a
    `subscribe` request fails, the hub now notifies the subscriber with a
    best-effort `GET` to the callback carrying `hub.mode=denied`, `hub.topic`, and
    `hub.reason` instead of silently dropping the request. New `notifyDenial` /
    `buildDenialUrl` helpers (SSRF-safe via `safeFetch`, never throwing) and a
    `websub.subscription.denied` event. An unconfirmed `unsubscribe` still leaves
    the existing subscription untouched and sends no denial.
  - **No fabricated `application/octet-stream` on distribution (WebSub §7).** When
    a topic response omits `Content-Type`, distribution no longer mislabels the
    body as `application/octet-stream`. A new optional `defaultContentType` config
    lets a hub declare the type its feeds are served as; absent both a topic header
    and that fallback, the content is refused (logged as
    `websub.topic.content_type_missing`) rather than mislabeled.
  - **`hub.lease_seconds=0` clamped, not rejected (WebSub §5.1).** A `0` (or
    negative) `hub.lease_seconds` is a _request_ the hub clamps up to its minimum
    rather than a `400 invalid_lease_seconds` rejection. Non-numeric values are
    still rejected.

- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
