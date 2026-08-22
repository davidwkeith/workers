---
"@dwk/websub": patch
---

Address three WebSub spec-compliance follow-ups (#94).

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
