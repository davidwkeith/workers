# @dwk/websub

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
