# @dwk/safe-fetch

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
