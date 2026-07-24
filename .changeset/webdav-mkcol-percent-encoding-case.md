---
"@dwk/webdav": patch
---

Fix `MKCOL` silently succeeding over an existing plain resource when the
request's percent-encoding hex case differs from the `PUT` that created it
(litmus `mkcol_over_plain`, following `put_get_utf8_segment`). RFC 3986 §2.1
treats `%e2` and `%E2` as the same octet, but the router resolved each
request's path straight from `URL#pathname`, which copies an already-encoded
triplet through verbatim rather than normalizing its case — so two requests
naming the same UTF-8 segment with different encoder casing produced
different path strings and missed each other in the backend's exact-match
lookup. `pathOf` now uppercases every percent-encoded triplet before it's
used anywhere downstream (backend calls, authorization, lock/precondition
checks), so encoding-case no longer affects resource identity.
