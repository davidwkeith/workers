# @dwk/microsub

Microsub server — the read side of IndieWeb.

## What this is

Manages feed subscriptions organized into channels, polls and parses sources
server-side (Atom, RSS, JSON Feed, h-feed via mf2), and serves normalized JF2
timelines to reader clients (Monocle, Together, Indigenous). Supports channel
CRUD with reordering, feed discovery, timeline pagination (before/after cursors),
per-channel unread counts, and scheduled polling via queue with dedup. Also
contributes read-only `@dwk/mcp` tools (`createMicrosubMcpTools` →
`microsub_list_channels`, `microsub_get_timeline`) over the same store the
HTTP `GET` actions use.

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
