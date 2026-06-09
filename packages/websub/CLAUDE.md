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
  `safeFetch` with private/reserved host blocking.
- **HMAC-SHA256 signatures.** When a subscriber provides a `hub.secret`,
  distributed content includes an `X-Hub-Signature` header with the
  HMAC-SHA256 of the body.
- **Lease management.** Subscriptions have a bounded lease period (configurable
  min/max). Expired subscriptions are not delivered to and are eventually pruned.
- **Queue-driven distribution.** On publish, the hub enqueues one job per
  subscriber via Cloudflare Queue. The queue consumer
  (`createWebSubQueueConsumer`) handles delivery with retries.
- **D1 for subscriptions.** All subscription state lives in D1 (`WEBSUB_DB`).

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- D1: `WEBSUB_DB`

```bash
pnpm test --project @dwk/websub
```

## File layout

```
src/index.ts          # public surface: createWebSub, publishNotifier, queue consumer, types
src/config.ts         # WebSubConfig type and Env fragment
src/handler.ts        # createWebSub factory (subscribe/unsubscribe/publish routes)
src/store.ts          # createD1SubscriptionStore (D1-backed subscription persistence)
src/validation.ts     # request parameter validation
src/verification.ts   # intent verification (hub.challenge callback)
src/distribution.ts   # content fetching, HMAC signing, subscriber delivery
src/queue.ts          # queue consumer and job types (VerifyJob, DistributeJob)
src/safe-fetch.ts     # SSRF-safe fetch with private IP blocking
src/*.test.ts         # colocated tests
```

## Dependencies

- `@dwk/log` — structured logging.
