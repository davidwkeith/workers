---
"@dwk/activitypub": patch
"@dwk/dpop": patch
"@dwk/host-meta": patch
"@dwk/http-signatures": patch
"@dwk/ldn": patch
"@dwk/log": patch
"@dwk/micropub": patch
"@dwk/microsub": patch
"@dwk/rdf": patch
"@dwk/remotestorage": patch
"@dwk/solid-pod": patch
"@dwk/store": patch
"@dwk/wac": patch
"@dwk/webfinger": patch
"@dwk/webmention": patch
"@dwk/websub": patch
---

Tidy package metadata for cross-package consistency.

- **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
  array so the Miniflare test harness no longer ships in the tarball, matching
  every other Durable-Object/`workerd` package.
- **`keywords`:** backfill an npm `keywords` array on the packages that lacked
  one, so all published packages carry discovery keywords in the same style.
- **`index.ts` doc comments:** normalize the spec pointer to the
  `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
  the libs whose headers had drifted, per the repo convention.
