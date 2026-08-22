---
"@dwk/webdav": patch
---

Wrap the top-level handler in try/catch so an unexpected backend exception
returns a well-formed DAV 500 response instead of escaping as a non-DAV
crash.
