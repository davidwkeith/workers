# @dwk/safe-fetch

## 0.1.0-beta.3

### Minor Changes

- 39f6d61: Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).

### Patch Changes

- 0e65ce3: Cap the number of batches scanned per client-list page — both the outbox
  owner-post merge into a Mastodon timeline and the inbox notifications scan —
  so a like/announce-dominated outbox or a plain-post-dominated inbox can no
  longer force a near-full-table scan per request. Also de-duplicate the
  cancellable timeout-signal helper: `@dwk/safe-fetch` now exports
  `createTimeoutSignal`, reused by `@dwk/activitypub` and `@dwk/webfinger`
  instead of each carrying its own copy.
- 36a3be1: Block 6to4 and Teredo IPv6 addresses that embed a private IPv4 (#298).
  `isPrivateOrReservedHost` already rejected IPv4-mapped / NAT64 forms, but not
  `2002::/16` (6to4 — the embedded IPv4 is groups 1–2, e.g. `2002:7f00:1::` carries
  `127.0.0.1`) or `2001:0000::/32` (Teredo — the client IPv4 is groups 6–7,
  bitwise-inverted). Both are now decoded and rejected when the embedded IPv4 is
  private/reserved, closing an SSRF bypass through those transition formats while
  still allowing 6to4/Teredo addresses that wrap a public IPv4.
- 3e505be: `safeFetchJson` now rejects a response whose `Content-Type` clearly isn't
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

- Updated dependencies [3e505be]
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.2

### Minor Changes

- 22c802a: Add `@dwk/safe-fetch` — SSRF-safe outbound fetch (`safeFetch`,
  `safeFetchJson`) and capped body reads (`readBodyCapped`, `readBytesCapped`),
  extracted from the near-duplicate copies in `@dwk/webmention`, `@dwk/websub`,
  `@dwk/microsub`, and `@dwk/vc`.

### Patch Changes

- 7b86416: Block the RFC 7686 `.onion` special-use TLD in `isPrivateOrReservedHost` /
  `assertPublicUrl`. Workers cannot reach Tor onion services, so a peer-supplied
  `.onion` URL now fails up front as a structured `blocked_host` `SsrfError`
  instead of an opaque network error at fetch time.
- Updated dependencies [6d14fc3]
  - @dwk/log@0.1.0-beta.3
