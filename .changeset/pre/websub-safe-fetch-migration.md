---
"@dwk/websub": patch
---

Move SSRF-safe fetch and capped body reads onto the shared `@dwk/safe-fetch`
package instead of a package-local copy. No public API change.
