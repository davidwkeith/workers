---
"@dwk/solid-oidc": patch
---

Call the injected `logger`/`metrics` seam at the token endpoint's
security-relevant rejection points (DPoP proof rejected, invalid/replayed
code, PKCE mismatch) — previously wired but never invoked anywhere in the
package.
