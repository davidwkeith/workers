---
"@dwk/atproto-pds": patch
---

Cap `createSession`, `updateHandle`, `createRecord`, `putRecord`, and
`deleteRecord`'s JSON body reads at a new `maxJsonBodyBytes` (default 2
MiB), stream-read the same way as the `#uploadBlob`/`#importRepo` fix in the
previous patch, instead of an uncapped `request.json()`. `createSession` is
the most severe of the five: it's the unauthenticated login endpoint, so
unlike the other four (all behind `#requireAuth`) it had no auth check ahead
of the buffer to limit who could trigger it.
