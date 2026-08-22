---
"@dwk/websub": minor
---

Add `@dwk/websub`, a WebSub (W3C) hub — the publish-side, real-time complement
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
