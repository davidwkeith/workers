---
"@dwk/activitypub": patch
"@dwk/atproto-pds": patch
"@dwk/calendar": patch
"@dwk/cf-shims": patch
"@dwk/deno-host": patch
"@dwk/dpop": patch
"@dwk/esi": patch
"@dwk/host-meta": patch
"@dwk/http-signatures": patch
"@dwk/indieauth": patch
"@dwk/ldn": patch
"@dwk/log": patch
"@dwk/mastodon-api": patch
"@dwk/mcp": patch
"@dwk/mf2": patch
"@dwk/micropub": patch
"@dwk/microsub": patch
"@dwk/oauth": patch
"@dwk/rdf": patch
"@dwk/remotestorage": patch
"@dwk/safe-fetch": patch
"@dwk/solid-oidc": patch
"@dwk/solid-pod": patch
"@dwk/store": patch
"@dwk/vc": patch
"@dwk/wac": patch
"@dwk/webauthn": patch
"@dwk/webdav": patch
"@dwk/webfinger": patch
"@dwk/webmention": patch
"@dwk/websub": patch
---

Add a `bugs` field to every publishable package manifest, so the npm package
page links to the repository issue tracker instead of omitting the "report
issues" link entirely. Metadata only — no runtime or API change.
