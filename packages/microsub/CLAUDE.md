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
src/feed.ts         # parseFeed (Atom/RSS/JSON Feed → JF2)
src/hfeed.ts        # parseHFeed (mf2 h-feed → JF2)
src/discovery.ts    # discoverFeed, fetchFeed (feed URL discovery + fetching)
src/safe-fetch.ts   # SSRF-safe fetch with private IP blocking
src/auth.ts         # token extraction, scope checking
src/queue.ts        # queue consumer and job types
src/*.test.ts       # colocated tests
```

## Dependencies

- `@dwk/dpop` — DPoP proof verification.
- `@dwk/indieauth` — access token verification.
- `@dwk/log` — structured logging.
