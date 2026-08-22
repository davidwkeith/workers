---
"@dwk/cf-shims": patch
---

Add `serializeAttachment`/`deserializeAttachment` to `EmulatedWebSocket`, the
Node shim `installWebSocketGlobals` installs for workerd's WebSocket
Hibernation API. A Durable Object (e.g. `@dwk/solid-pod`'s WAC-filtered
broadcast) calling `server.serializeAttachment(...)` on an accepted socket
previously threw `TypeError: server.serializeAttachment is not a function`
on Node, since the shim implemented `send`/`close`/`accept` but not the
attachment methods. Since this shim never actually hibernates, a plain
in-memory field is a faithful-enough emulation: `serializeAttachment` sets
it, `deserializeAttachment` reads it back (`null` if never set).
