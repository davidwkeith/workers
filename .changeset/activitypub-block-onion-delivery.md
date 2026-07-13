---
"@dwk/activitypub": patch
---

Reject `.onion` inboxes in the outbound-delivery SSRF guard
(`assertPublicHttpsTarget`). Workers cannot reach Tor onion services (RFC 7686
keeps `.onion` out of public DNS), so such targets are now dropped
non-retryably as `blocked_host` instead of failing at the network layer.
