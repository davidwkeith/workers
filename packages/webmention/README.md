# `@dwk/webmention`

> Webmention (W3C) receiver + sender. Endpoint package.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/webmention.md) for the full
requirements.

The receiver validates `source`/`target` **synchronously**, returns
`202 Accepted`, and enqueues the pair for **asynchronous** link verification.
The queue consumer fetches the source, confirms it links to the target, and
persists (or removes) the mention in an inbox. The sender discovers a target's
Webmention endpoint and notifies it on publish. Cloudflare specifics (Queue,
D1) are confined to this package; the parsing and verification logic is pure and
unit-tests without a Workers runtime.

## Receiver

```ts
import { createWebmention } from "@dwk/webmention";

const webmention = createWebmention({ baseUrl: "https://example.com" });

// In your Worker's fetch handler, mount under any path prefix:
//   POST /webmention   (application/x-www-form-urlencoded: source, target)
return webmention(request, env, ctx);
```

`createWebmention` validates up front — both fields are syntactically valid
`http(s)` URLs, `source` ≠ `target`, and `target` is a resource under this
receiver's control (`baseUrl`'s host, plus any `allowedHosts`). Invalid requests
get `400` with a stable error code in the body; valid ones are enqueued and get
`202`. Other methods get `405`. The handler **fails loudly** if the required
`WEBMENTION_QUEUE` binding is missing.

### Async verification (queue consumer)

```ts
import { createWebmentionQueueConsumer } from "@dwk/webmention";

const verify = createWebmentionQueueConsumer({ baseUrl: "https://example.com" });

export default {
  fetch: webmention,
  queue: verify, // bound to WEBMENTION_QUEUE
};
```

The consumer fetches each `source`, checks for a link to `target`, and **upserts**
the verified mention into the inbox — or **removes** it when the source no longer
links. Jobs that throw are retried.

## Sender

```ts
import { sendWebmentions } from "@dwk/webmention";

// On publish, notify each outbound link's target:
const results = await sendWebmentions(myPostUrl, outboundLinks);
```

Endpoint discovery follows the spec: the HTTP `Link` header (`rel=webmention`)
wins, then the first `<link>`/`<a rel="webmention">` in document order, with
relative URLs resolved against the (post-redirect) document URL — honoring a
`<base href>` and ignoring endpoints inside HTML comments. The legacy
`http://webmention.org/` rel is also accepted. The sender refuses to POST a
discovered endpoint that is not `http(s)`.

### Re-sending after a delete (§3.1.5)

When a published page is later deleted, the spec asks the publisher to
re-send its Webmentions so each receiver re-verifies, sees the `410 Gone`,
and drops the stored mention. That requires remembering who was notified —
opt in by passing a sent log:

```ts
import {
  createD1SentLog,
  sendWebmentions,
  resendForDeletedSource,
} from "@dwk/webmention";

const sentLog = createD1SentLog(env.WEBMENTION_INBOX); // own table: webmentions_sent

// On publish — accepted notifications are recorded:
await sendWebmentions(myPostUrl, outboundLinks, { sentLog });

// After the page is deleted and serving 410 Gone:
await resendForDeletedSource(myPostUrl, { sentLog });
```

Re-send the mentions only once the deletion is live — a receiver re-verifying
against a still-`200` source keeps the mention. Rows are cleared for targets
that accept the re-send (or no longer declare an endpoint); failed targets
keep their row so a later call retries them.

## Bindings (`Env` fragment)

| Binding            | Type         | Required | Purpose                                  |
| ------------------ | ------------ | -------- | ---------------------------------------- |
| `WEBMENTION_QUEUE` | `Queue`      | yes      | Async verification of received mentions. |
| `WEBMENTION_INBOX` | `D1Database` | yes\*    | Default inbox for verified mentions.     |

\* `WEBMENTION_INBOX` is optional when you pass a custom `inbox` in config — for
example, to store mentions in the `@dwk/solid-pod` Durable Object when composed
into a pod.

## Config

| Field          | Type         | Default        | Purpose                                       |
| -------------- | ------------ | -------------- | --------------------------------------------- |
| `baseUrl`      | `string`     | —              | Receiver origin; `target` must live under it. |
| `allowedHosts` | `string[]`   | `[]`           | Extra controlled hostnames.                   |
| `inbox`        | `InboxStore` | D1 from `env`  | Override the default inbox store.             |
| `fetch`        | `FetchLike`  | global `fetch` | Override `fetch` (verification/discovery).     |
| `logger`       | `Logger`     | `noopLogger`   | Structured logs (see `@dwk/log`).             |
| `metrics`      | `Metrics`    | `noopMetrics`  | Queryable counters (see `@dwk/log`).          |

## Observability

Logging and metrics are **opt-in and injected** (see [`@dwk/log`](../log)),
defaulting to no-ops. Both seams share one event vocabulary
(`WebmentionLogEvent`), so a log line and its counter line up — SSRF blocks (by
reason), receive accepted/rejected, verification outcomes (by links/status),
queue retries (by reason), and send outcomes (by delivered/status):

```ts
import { consoleLogger, analyticsEngineMetrics } from "@dwk/log";
import { createWebmention } from "@dwk/webmention";

const webmention = createWebmention({
  baseUrl: "https://example.com",
  logger: consoleLogger({ minLevel: "info" }),
  // env.WEBMENTION_METRICS is an AnalyticsEngineDataset binding.
  metrics: analyticsEngineMetrics(env.WEBMENTION_METRICS),
});
```

Both honor the redaction policy: only sanitized hosts, status, reason codes,
booleans, and counts — never tokens, bodies, or full URLs.

## Federation handoff (documented config, not core code)

To bridge to the fediverse, emit `h-card` / `h-entry` markup on your published
pages and include [Bridgy Fed](https://fed.brid.gy/) (`https://fed.brid.gy/`) as
one of the outbound targets you pass to `sendWebmentions`. Bridgy Fed discovers
your page's Webmention endpoint and handles the ActivityPub translation; no
special code in this package is required.

## Conformance

The discovery and verification logic is unit-tested against the
[webmention.rocks](https://webmention.rocks/) discovery cases — including exact
`rel` matching (not naïve substring), endpoints hidden in HTML comments, escaped
HTML, empty vs. missing `href`, `<base href>` resolution, query-string
endpoints, and multiple/ordered endpoint advertisements.

## Scope

- Verification is **link-level**: the source document must contain an
  `href`/`src` resolving to the target. Full **Microformats2** extraction (author,
  content, mention type) is intentionally out of scope to keep the Worker bundle
  within the runtime budget; the inbox records `source`, `target`, and the
  verification time.

## License

[ISC](../../LICENSE)
