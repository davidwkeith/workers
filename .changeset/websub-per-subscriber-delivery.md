---
"@dwk/websub": minor
---

Distribute content per-subscriber instead of in one unbounded fan-out. A
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
