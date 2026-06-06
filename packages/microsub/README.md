# `@dwk/microsub`

> Microsub server: channel/feed subscriptions, server-side polling, and a normalised JF2 timeline. Consumes IndieAuth tokens.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/microsub.md) for the full requirements.

A [Microsub](https://indieweb.org/Microsub-spec) server that runs as a
Cloudflare Worker — the IndieWeb's **read side**, completing the loop alongside
[`@dwk/micropub`](../micropub) (write), [`@dwk/webmention`](../webmention)
(interaction), [`@dwk/indieauth`](../indieauth) (identity), and
[`@dwk/websub`](../websub) (push).

It manages feed subscriptions organised into channels, polls and parses sources
server-side (Atom / RSS / JSON Feed / `h-feed`), and serves a normalised
[JF2](https://jf2.spec.indieweb.org/) timeline to reader clients (Monocle,
Together, Indigenous). The user's reading state lives on infrastructure they
own, not in a hosted aggregator.

## Usage

```ts
import {
  createMicrosub,
  createMicrosubPoller,
  createMicrosubQueueConsumer,
} from "@dwk/microsub";

const config = {
  baseUrl: "https://example.com",
  // the owner's IndieAuth profile URL; tokens minted for any other `me` are
  // rejected even if they carry the right scope
  me: "https://example.com/",
  // optional: defaults to `${origin}/microsub`
  microsubEndpoint: "https://example.com/microsub",
};

const microsub = createMicrosub(config);
const poll = createMicrosubPoller(config);
const consume = createMicrosubQueueConsumer(config);

export default {
  fetch(request, env, ctx) {
    return microsub(request, env, ctx);
  },
  // Cron Trigger: enqueue a poll job per followed feed.
  scheduled(controller, env, ctx) {
    return poll(controller, env, ctx);
  },
  // Queue consumer: fetch + parse + append to channel timelines.
  queue(batch, env, ctx) {
    return consume(batch, env, ctx);
  },
};
```

### Bindings (declared `Env` fragment)

The handler fails loudly at startup if any of these are missing:

- `MICROSUB_DB` — D1 database for channels, follows, timeline items, and the
  per-feed poll cache.
- `MICROSUB_QUEUE` — Queue for feed-poll fan-out and retries.
- `AUTH_DB` — the [`@dwk/indieauth`](../indieauth) issued-token store, consulted
  for revocation.
- `TOKEN_SIGNING_KEY` — the secret the IndieAuth token endpoint signs tokens with.

### What it implements

The single endpoint dispatches on the `action` (and `method`) parameter:

- **Channels** (`action=channels`): list, create, rename, delete
  (`method=delete`), and reorder (`method=order`). A reserved `notifications`
  channel always exists and cannot be deleted or renamed.
- **Following** (`action=follow` / `action=unfollow`): subscribe with feed
  discovery (Atom / RSS / JSON Feed / `h-feed`); a follow populates the timeline
  immediately and primes the poll cache.
- **Timeline** (`action=timeline`): JF2 entries with `before` / `after` opaque
  cursors, `mark_read` / `mark_unread` (`entry`, `entry[]`, or
  `last_read_entry`), `remove`, and per-channel unread counts.
- **Search / preview** (`action=search` / `action=preview`): discover or preview
  a feed's entries without subscribing.

Every request is authorized by a DPoP-bound IndieAuth access token whose subject
must match the configured `me`, with the proof-of-possession binding completed
via [`@dwk/dpop`](../dpop) and revocation checked against the strongly-consistent
token store. Polling runs off the read path on a Cron-triggered queue; the read
path serves stored entries only. Every outbound fetch is SSRF-guarded.

## License

[ISC](../../LICENSE)
