# @dwk/microsub

Microsub server — the read side of IndieWeb.

## What this is

Manages feed subscriptions organized into channels, polls and parses sources
server-side (Atom, RSS, JSON Feed, h-feed via mf2), and serves normalized JF2
timelines to reader clients (Monocle, Together, Indigenous). Supports channel
CRUD with reordering, feed discovery, timeline pagination (before/after cursors),
per-channel unread counts, and scheduled polling via queue with dedup.

## Spec

`spec/packages/microsub.md` — authoritative requirements.

## Key constraints

- **IndieAuth token validation.** Reuses `@dwk/indieauth` for access token
  verification with DPoP binding. Requires `read`, `follow`, `mute`, `block`,
  `channels` scopes as appropriate.
- **Queue-driven polling.** Feed polling is triggered via Cloudflare Queue
  messages, not in-request. The `createMicrosubPoller` (scheduled handler) and
  `createMicrosubQueueConsumer` handle the async pipeline.
- **SSRF protection.** Feed fetching uses `safeFetch` with private/reserved host
  blocking — never fetch from internal IPs.
- **Notifications channel.** `NOTIFICATIONS_CHANNEL` is a reserved channel name
  for cross-channel notification items.
- **D1 for all state.** Channels, follows, timeline items, and feed cache all
  live in D1 (`MICROSUB_DB`). Auth state in `AUTH_DB`.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers`. Miniflare config:

- D1: `MICROSUB_DB`, `AUTH_DB`
- Bindings: `TOKEN_SIGNING_KEY` (test key)

```bash
pnpm test --project @dwk/microsub
```

## File layout

```
src/index.ts        # public surface: createMicrosub, poller, queue consumer, store, feed parsing
src/config.ts       # MicrosubConfig type and Env fragment
src/handler.ts      # createMicrosub factory (channel/follow/timeline/search actions)
src/store.ts        # createMicrosubStore (D1-backed channels, follows, timeline)
src/jf2.ts          # feed → JF2 normalization (JSON Feed/Atom/RSS/h-feed entries)
src/xml.ts          # minimal dependency-free XML reader for Atom/RSS parsing
src/hfeed.ts        # h-feed/h-entry mf2 parsing (HTMLRewriter → JF2)
src/discovery.ts    # discoverFeed (feed URL discovery + parsing)
src/auth.ts         # token extraction, scope checking, DPoP enforcement
src/replay.ts       # D1-backed DPoP proof jti replay record (short TTL)
src/poll.ts         # createMicrosubPoller (scheduled: one queue job per feed)
src/queue.ts        # queued poll job shapes
src/consumer.ts     # createMicrosubQueueConsumer (fetch, parse, append)
src/log.ts          # structured observability event taxonomy (@dwk/log vocabulary)
src/test-harness.ts # test-only DPoP/token helpers (not published)
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/dpop` — DPoP proof verification.
- `@dwk/indieauth` — access token verification.
- `@dwk/log` — structured logging.
- `@dwk/safe-fetch` — SSRF-safe fetch (`safeFetch`, `readBodyCapped`,
  `FetchLike`) with private/reserved IP blocking; re-exported from
  `index.ts` for backwards compatibility.
