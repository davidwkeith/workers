---
"@dwk/webdav": patch
---

Fix `mintAppPassword` throwing `NotSupportedError` on every call in production:
`DEFAULT_PBKDF2_ITERATIONS` was set to OWASP's 2023-recommended 600,000, but
workerd's `crypto.subtle.deriveBits` hard-rejects PBKDF2 iteration counts above
100,000. Capped the default at that runtime ceiling — still within OWASP's
longstanding prior-generation minimum — so the owner-gated app-password mint
endpoint (`createSolidPodWebdavCredentials`) actually works on Cloudflare
Workers.
