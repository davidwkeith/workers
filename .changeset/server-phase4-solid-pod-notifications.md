---
"@dwk/server": minor
---

Complete Phase 4 self-hosting: bring up `@dwk/solid-pod` on the emulated Durable
Object, including WebSocket notifications.

- `@dwk/solid-pod` now runs end-to-end through the host on the Node DO emulation:
  LDP create/read/`If-Match`/delete, Solid N3 Patch, WAC (owner allowed,
  non-owner `403`, anonymous `401`), and opaque blob bodies streamed through R2 —
  all driven over real HTTP through `createServer`.
- WebSocket hibernation is emulated so Solid notification channels work on Node:
  a `WebSocketPair` of linked in-memory sockets, a `Response` that carries a
  `webSocket` + `101` status (both of which Node's `Response` otherwise rejects),
  and a `webSocketMessage`/`webSocketClose` bridge from the DO state. The host
  bridges real client WebSockets to the matching mount's DO over an HTTP
  `upgrade` via the `ws` library, so a subscriber receives change notifications
  when a resource is written. Adds `ws` as a dependency.

With this, every `@dwk` package — stateless, D1/R2-backed, queue/cron, and
Durable Object — runs on the self-hosting host.
