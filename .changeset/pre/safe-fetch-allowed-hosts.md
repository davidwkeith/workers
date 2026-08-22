---
"@dwk/safe-fetch": minor
"@dwk/webmention": minor
"@dwk/websub": minor
"@dwk/microsub": minor
"@dwk/vc": minor
"@dwk/atproto-pds": minor
---

Add a composer-injected local-dev SSRF allowlist (issue #257): `@dwk/safe-fetch` gains `allowedHosts` — exact `host[:port]` entries exempted from the private/loopback host block, with every use logged/counted as `safe_fetch.ssrf.allowed_host` — and the consuming packages expose it as `fetchAllowedHosts` in their options/config (webmention verify/discovery/send, websub verify/denial/distribute, microsub feed discovery/fetch, vc did:web resolution + status-list fetch, atproto-pds PLC directory + DID resolution). Deny-by-default is unchanged; scheme checks, redirect re-validation, timeouts, and body caps still apply to allowlisted hosts. This unblocks local `wrangler dev --local` debugging against the local dev site (Anglesite-app#708).
