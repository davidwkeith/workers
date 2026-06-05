# `@dwk/microsub`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [Microsub](https://indieweb.org/Microsub-spec) |
| **Status** | proposed — tracked in [#91](https://github.com/davidwkeith/workers/issues/91) |

A [Microsub](https://indieweb.org/Microsub-spec) server: the IndieWeb's
**read side**. It completes the loop alongside the write side
([`@dwk/micropub`](micropub.md)), the interaction side
([`@dwk/webmention`](webmention.md)), the identity layer
([`@dwk/indieauth`](indieauth.md)), and the publish/push side
([`@dwk/websub`](websub.md)).

A Microsub server is the social-reader's back end: it manages feed
**subscriptions** organised into **channels**, polls and parses sources
server-side, and serves a normalised **JF2** timeline to reader clients
(Monocle, Together, Indigenous). The user's reading state lives on
infrastructure they own rather than in a hosted aggregator.

## Worker vs. Anglesite (the static split)

As with WebSub, feed *generation* stays in Anglesite — nothing here emits a
feed. Microsub is the dynamic layer that consumes *other people's* feeds:
discovery, polling, parsing to JF2, dedupe, and the channel/timeline state
machine. Discovery of the endpoint itself (`<link rel="microsub">`) is
Anglesite's to emit on the user's home page.

## Functional requirements

- Export `createMicrosub(config)` returning the standard handler, mountable
  under a path prefix as the single Microsub endpoint. The `action` query/form
  parameter selects the operation; `method` sub-selects (e.g. `method=delete`,
  `method=order`, `method=mark_read`).
- **Auth:** every request carries a DPoP-bound IndieAuth access token (issued by
  [`@dwk/indieauth`](indieauth.md)); the token's subject (`me`) **MUST** match
  the configured server identity, exactly as Micropub gates its writes.
- **Channels:** `list` / `create` / `update` (rename) / `delete` / **reorder**
  (`method=order`). A reserved `notifications` channel always exists and cannot
  be deleted, renamed, or reordered away.
- **Following:** `follow` / `unfollow` with feed discovery (Atom / RSS / JSON
  Feed / `h-feed`). A follow kicks an immediate poll so the timeline populates
  without waiting for the next scheduled run.
- **Timeline:** JF2 entries with `before` / `after` opaque-cursor pagination,
  `mark_read` / `mark_unread` (`entry`, `entry[]`, or `last_read_entry`),
  `remove`, and per-channel unread counts.
- **Search / preview:** discover or preview a feed's entries without
  subscribing.
- **Polling:** a scheduled (Cron Trigger) poller enqueues a job per distinct
  followed feed; a queue consumer fetches (conditional `ETag` /
  `Last-Modified`), parses to JF2, dedupes, and appends to every channel
  following that feed. The read path serves stored entries only — never an
  inline fetch.

## Design constraints

- The subscription + timeline store **MUST** be strongly consistent — D1
  (session consistency), **never KV**: a lost subscription or a dropped/stale
  read-state flag is a correctness bug, not a safe-to-be-stale cache
  ([non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- Polling runs on a **queue** / Cron Trigger with backoff; the read path never
  fetches a source inline.
- Outbound fetches (discovery, polling, preview, search) hit attacker-influenced
  URLs, so every one goes through an **SSRF-safe** wrapper that blocks
  private / loopback / link-local hosts and re-validates each redirect hop, and
  caps the fetched body so a hostile source cannot OOM the Worker.

## Bindings (declared `Env` fragment)

The handler fails loudly at startup if any of these are missing:

- **`MICROSUB_DB`** — D1 database for channels, follows, timeline items, and the
  feed poll cache.
- **`MICROSUB_QUEUE`** — Queue for feed-poll fan-out and retries.
- **`AUTH_DB`** — the [`@dwk/indieauth`](indieauth.md) issued-token store,
  consulted for revocation.
- **`TOKEN_SIGNING_KEY`** — the secret the IndieAuth token endpoint signs tokens
  with.

## Config

- `baseUrl` / domain and the owner's IndieAuth `me`.
- Optional `microsubEndpoint` (defaults to `${origin}/microsub`).
- Page size, item-retention ceiling, poll interval, and the SSRF-safe `fetch`.

## Conformance / testing

No hosted suite exists (unlike micropub.rocks / webmention.rocks). Validate
against the spec, interop-test with Monocle / Together / Indigenous, and cover
the channel/timeline state machine and the feed → JF2 parsers (Atom, RSS, JSON
Feed, `h-feed`) with colocated unit tests. See
[conformance-and-testing.md](../conformance-and-testing.md).
