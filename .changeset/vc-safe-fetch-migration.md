---
"@dwk/vc": patch
---

Move the status-list SSRF-safe fetch onto the shared `@dwk/safe-fetch`
package instead of a package-local copy. No public API change and no
behavior change (still https-only, 1 MB body cap, same `vc.ssrf.blocked`
log event).
