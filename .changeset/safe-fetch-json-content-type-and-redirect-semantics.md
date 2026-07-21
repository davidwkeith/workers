---
"@dwk/safe-fetch": patch
---

`safeFetchJson` now rejects a response whose `Content-Type` clearly isn't
JSON (e.g. `text/html`) instead of handing it to `JSON.parse`, matching the
"content-type-checked" contract documented in `spec/packages/safe-fetch.md`.
A missing header, `text/plain`, and `+json` suffixes (`application/did+json`,
`application/ld+json`, ...) are still accepted.

`safeFetch` now downgrades a `303` (or a `301`/`302` responding to a `POST`)
to a bodyless `GET` on the next redirect hop, matching the WHATWG Fetch
redirect algorithm and every browser's behavior, instead of re-sending the
original method and body. `Content-Type`/`Content-Encoding`/`Content-Language`/
`Content-Location` are stripped on the downgraded hop (per the Fetch spec),
and `Content-Length` is stripped too so a stale value never survives onto a
request that no longer has a body. `307`/`308` still preserve the method and
body, as documented, and the redirect docs now note that a streamed
(`ReadableStream`) body can't be re-sent across hops.
