---
"@dwk/solid-pod": patch
---

WAC-filter WebSocket change notifications per subscriber instead of
broadcasting every resource change (including private resources) to every
connected socket unfiltered. An anonymous or unauthorized client can no
longer passively enumerate pod contents by watching the notification stream.

**Behaviour change for subscribers.** A subscription is authenticated from its
upgrade request's `Authorization` header, which the browser `WebSocket` API
cannot set — so browser-originated subscriptions authenticate as anonymous and
now receive notifications only for publicly-readable resources, where before
they received every change in the pod. Server-side subscribers that can set the
header (and the pod owner) are unaffected. Carrying a token on a browser
handshake — e.g. a Solid Notifications subscription endpoint that mints a
bearer-bound channel URL, or a token passed via `Sec-WebSocket-Protocol` — is
not implemented here.
