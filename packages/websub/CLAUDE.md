# @dwk/websub

WebSub (W3C) hub endpoint.

## What this is

Hub implementation for WebSub (formerly PubSubHubbub). Manages subscriptions
with lease expiry in D1, performs intent-verification callbacks on
subscribe/unsubscribe, and distributes content to subscribers on publish with
HMAC-SHA256 signatures. Uses a queue for fan-out delivery. Provides a
publish-ping entry point for atomicity with Anglesite site builds.

## Spec

`spec/packages/websub.md` — authoritative requirements.

## Key constraints

- **Intent verification.** Every subscribe/unsubscribe triggers a synchronous
  GET callback to the subscriber's callback URL with `hub.challenge`. The
  subscription is only persisted after successful verification.
- **SSRF protection.** Intent verification and content distribution use
  `safeFetch` (from `@dwk/safe-fetch`) with private/reserved host blocking.
- **HMAC-SHA256 signatures.** When a subscriber provides a `hub.secret`,
  distributed content includes an `X-Hub-Signature` header with the
  HMAC-SHA256 of the body.
- **Lease management.** Subscriptions have a bounded lease period (configurable
  min/max). Expired subscriptions are not delivered to and are eventually pruned.
- **Queue-driven, two-stage distribution.** On publish the hub enqueues one
  `distribute` job. The consumer (`createWebSubQueueConsumer`) treats that as a
  fan-out _planner_: it fetches the topic snapshot once and enqueues one
  `deliver` job **per active subscriber**, so each subscriber retries on its own
  queue checkpoint (a callback down for a while no longer misses the update, a
  large subscriber set no longer blows the per-invocation subrequest ceiling, and
  a single failure no longer re-delivers to everyone). Small snapshots ride
  inline in each `deliver` message; a body too large to inline is staged once in
  R2 (`WEBSUB_CONTENT`) and referenced by key.
- **D1 for subscriptions.** All subscription state lives in D1 (`WEBSUB_DB`).
- **R2 for large snapshots (optional).** `WEBSUB_CONTENT` stages a distribution
  body only when it exceeds the inline queue-message limit. A hub whose feeds
  always fit inline never needs it; when a snapshot does exceed the limit and the
  binding is absent, the fan-out fails loudly rather than truncating the push.
  Stage objects are transient — give the bucket an R2 lifecycle expiration rule
  (≥ the queue's message-retention window); the delivery path never deletes them.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- D1: `WEBSUB_DB`
- Queue: `WEBSUB_QUEUE` (fan-out of per-subscriber deliver jobs)
- R2: `WEBSUB_CONTENT` (optional; stages snapshots too large to inline)

```bash
pnpm test --project @dwk/websub
```

## File layout

```
src/index.ts          # public surface: createWebSub, publishNotifier, queue consumer, types
src/config.ts         # WebSubConfig type and Env fragment
src/handler.ts        # createWebSub factory (subscribe/unsubscribe/publish routes)
src/store.ts          # createD1SubscriptionStore (D1-backed subscription persistence)
src/validate.ts       # request parameter validation
src/verify.ts         # intent verification (hub.challenge callback)
src/distribute.ts     # content fetching, HMAC signing, subscriber delivery
src/queue.ts          # queued job shapes (verify + distribute kinds)
src/consumer.ts       # createWebSubQueueConsumer (verification + fan-out delivery)
src/log.ts            # structured observability event taxonomy (@dwk/log vocabulary)
src/*.test.ts         # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
- `@dwk/safe-fetch` — SSRF-safe fetch, capped body reads, and cross-origin
  header stripping for intent verification and content distribution.
