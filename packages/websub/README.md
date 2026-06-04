# `@dwk/websub`

> WebSub (W3C) hub. Endpoint package.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/websub.md) for the full
requirements.

A WebSub hub is the **publish-side, real-time complement** to
[`@dwk/webmention`](../webmention)'s interaction side: subscribers receive a
push when the user's feed changes instead of polling. Subscribe/unsubscribe
requests are validated **synchronously** (fast `202 Accepted`); the
verification-of-intent callback and content fan-out run **asynchronously** on a
queue with retries and backoff. The subscription store is **D1 (strongly
consistent), never KV** — a stale or lost subscription is a correctness bug. On
publish the hub fetches the topic and POSTs it to every verified callback,
signing the body with HMAC-SHA256 (`X-Hub-Signature`) when the subscriber
registered a secret.

## What this package does *not* do

The **feeds themselves are static** — RSS / Atom / JSON Feed and `h-feed` /
`h-entry` microformats are SSG build artifacts that **Anglesite generates**, so
there is no `@dwk/feeds` package and feed generation is out of scope here. The
feed's `Link rel="hub"` / `rel="self"` advertisement is likewise Anglesite's to
emit. This package is only the dynamic hub a static host can't provide.

## Hub endpoint

```ts
import { createWebSub } from "@dwk/websub";

const websub = createWebSub({
  baseUrl: "https://hub.example.com",
  // The feeds this hub serves; a subscribe/publish for any other topic is 400.
  allowedTopics: ["https://example.com/feed.xml"],
});

// In your Worker's fetch handler, mount under any path prefix:
//   POST /websub   (application/x-www-form-urlencoded)
return websub(request, env, ctx);
```

`createWebSub` parses the form body and routes on `hub.mode`:

- **`subscribe` / `unsubscribe`** — validates `hub.callback`, `hub.topic`,
  optional `hub.lease_seconds` (clamped into the hub's bounds), and optional
  `hub.secret` (< 200 bytes); enqueues a verification job and returns `202`.
- **`publish`** — validates `hub.url` (or legacy `hub.topic`) against the
  allowed topics; enqueues a distribution job and returns `202`.

Invalid requests get `400` with a stable error code in the body; other methods
get `405`. The handler **fails loudly** if the required `WEBSUB_QUEUE` binding
is missing.

### Async work (queue consumer)

```ts
import { createWebSub, createWebSubQueueConsumer } from "@dwk/websub";

const config = {
  baseUrl: "https://hub.example.com",
  allowedTopics: ["https://example.com/feed.xml"],
};

export default {
  fetch: createWebSub(config),
  queue: createWebSubQueueConsumer(config), // bound to WEBSUB_QUEUE
};
```

The consumer handles both job kinds:

- **verify** — issues the `hub.challenge` GET to the callback; on a confirming
  `2xx` echo it activates the subscription (subscribe) or removes it
  (unsubscribe). A subscription row is written **only after** verification
  succeeds, so an unverified callback never lands in the store.
- **distribute** — prunes expired leases, fetches the topic's current content,
  and POSTs it (signed per-subscriber when a secret is set) to every active
  callback.

A store/queue failure — or a distribution that can't fetch the topic — is
retried; everything else is acked.

### Publishing from your own write path

To ping the hub in-process when [`@dwk/micropub`](../micropub) writes or a static
rebuild finishes — instead of POSTing the HTTP publish endpoint — use the
notifier:

```ts
import { createPublishNotifier } from "@dwk/websub";

const notifyPublish = createPublishNotifier(config);
// After a write that changed the feed:
await notifyPublish(env, "https://example.com/feed.xml");
```

## Bindings (`Env` fragment)

| Binding        | Type         | Required | Purpose                                          |
| -------------- | ------------ | -------- | ------------------------------------------------ |
| `WEBSUB_DB`    | `D1Database` | yes      | Strongly-consistent subscription store.          |
| `WEBSUB_QUEUE` | `Queue`      | yes      | Verification + distribution fan-out and retries. |

The subscription store **MUST** be D1 (or another strongly-consistent store),
**never KV**: staleness here is a correctness/security bug, not a safe-to-be-stale
cache (see [`spec/non-functional-requirements.md`](../../spec/non-functional-requirements.md)).

## Config

| Field                 | Type                          | Default          | Purpose                                                       |
| --------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------- |
| `baseUrl`             | `string`                      | —                | Hub base URL.                                                 |
| `hubUrl`              | `string`                      | `baseUrl`        | URL advertised in the `rel="hub"` `Link` header.              |
| `allowedTopics`       | `string[]`                    | —                | Topics this hub serves (normalized match).                    |
| `isAllowedTopic`      | `(topic) => boolean`          | from `allowed…`  | Predicate alternative for a dynamic feed set.                 |
| `minLeaseSeconds`     | `number`                      | `300`            | Lower bound on a granted lease.                               |
| `maxLeaseSeconds`     | `number`                      | `864000`         | Upper bound on a granted lease (10 days).                     |
| `defaultLeaseSeconds` | `number`                      | `864000`         | Lease when the subscriber omits `hub.lease_seconds`.          |
| `fetch`               | `FetchLike`                   | global `fetch`   | Override `fetch` (verification / distribution).               |
| `logger`              | `Logger`                      | `noopLogger`     | Structured logs (see `@dwk/log`).                             |
| `metrics`             | `Metrics`                     | `noopMetrics`    | Queryable counters (see `@dwk/log`).                          |

Either `allowedTopics` or `isAllowedTopic` is required — a hub must know which
topics it serves.

## Security

Every outbound request — the verification GET and each distribution POST — goes
through an SSRF-safe `fetch`: the callback host (and every redirect hop) is
validated against private, loopback, link-local (incl. the cloud metadata IP),
and reserved ranges, redirects are followed manually with re-validation and a
hop cap, and the whole operation is bounded by a timeout. Credential-bearing
headers (including `X-Hub-Signature`) are stripped on a cross-origin redirect.

## Observability

Logging and metrics are **opt-in and injected** (see [`@dwk/log`](../log)),
defaulting to no-ops. Both seams share one event vocabulary (`WebSubLogEvent`),
so a log line and its counter line up — SSRF blocks (by reason), request
accepted/rejected, verification outcomes (by confirmed/status), subscription
activated/removed, deliveries (by delivered/status), topic-fetch failures, and
queue retries. Only sanitized hosts, status, reason codes, booleans, and counts
are recorded — never secrets, bodies, or full URLs.

## Conformance

The hub targets the [websub.rocks](https://websub.rocks/) hub test suite. The
lease math, request validation, intent verification, and HMAC signing are
unit-tested without a Workers runtime; the D1 store is tested under Miniflare.

## License

[ISC](../../LICENSE)
