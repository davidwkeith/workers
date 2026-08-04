---
"@dwk/indieauth": patch
---

Wrap the handler's route dispatch in a try/catch so an unexpected exception
(e.g. a D1 failure) returns a structured `server_error` OAuth response instead
of crashing unhandled. Also add a runtime shape guard on the stored `profile`
JSON before trusting it as `ProfileInfo`, instead of blind-casting it.
