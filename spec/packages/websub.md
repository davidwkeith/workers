# `@dwk/websub`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [WebSub](https://www.w3.org/TR/websub/) (ex-PubSubHubbub) |
| **Status** | proposed — tracked in [#60](https://github.com/davidwkeith/workers/issues/60) |

A WebSub hub: the publish-side, real-time complement to
[`@dwk/webmention`](webmention.md)'s interaction side. Subscribers receive a
push when the user's feed changes instead of polling.

## Worker vs. Anglesite (the static split)

The **feeds themselves are static** — RSS / Atom / JSON Feed files and
`h-feed` / `h-entry` microformats are SSG build artifacts that **Anglesite
generates**. There is therefore **no `@dwk/feeds` package**; feed generation is
out of scope here. WebSub is the **dynamic layer on top** that a static host
cannot provide:

- `hub.mode=subscribe|unsubscribe` requests with intent-verification callbacks;
- a subscription store with lease expiry;
- signed content distribution on publish;
- a publish-ping entry point invoked when Anglesite rebuilds or
  [`@dwk/micropub`](micropub.md) writes.

## Functional requirements

- Export `createWebSub(config)` returning the standard handler, mountable under
  a path prefix as the hub endpoint.
- **Subscribe / unsubscribe:** accept `hub.callback`, `hub.topic`, `hub.mode`,
  `hub.lease_seconds`; perform the verification-of-intent `GET` to the
  callback with `hub.challenge`.
- **Lease management:** renew and expire leases; prune dead subscribers.
- **Content distribution:** on publish, `POST` the updated topic to each
  verified callback with an `X-Hub-Signature` HMAC when the subscriber
  registered a `hub.secret`.
- **Publish ping:** an entry point (called by the build / Micropub write path)
  that marks a topic changed and enqueues distribution.

## Design constraints

- The subscription store **MUST** be strongly consistent — D1 (session
  consistency), **never KV**: a stale or lost subscription is a correctness bug,
  not a safe-to-be-stale cache
  ([non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- Delivery retries and fan-out run via a **queue** / DO alarms with backoff; the
  hub advertises itself via `Link rel="hub"` (the feed `Link` headers/elements
  are Anglesite's to emit).

## Bindings (declared `Env` fragment)

- **D1** for the subscription table.
- A **queue** for distribution fan-out and retries.

## Config

- `baseUrl` / domain.
- Allowed topic URLs (the feeds this hub will serve).
- Lease bounds (min / max / default `lease_seconds`).

## Conformance / testing

- W3C WebSub; interop with existing subscribers (feed readers) and historical
  hubs. See [conformance-and-testing.md](../conformance-and-testing.md).
