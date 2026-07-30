---
"@dwk/solid-pod": patch
---

WAC-filter WebSocket change notifications per subscriber instead of
broadcasting every resource change (including private resources) to every
connected socket unfiltered. An anonymous or unauthorized client can no
longer passively enumerate pod contents by watching the notification stream.
