---
"@dwk/micropub": patch
---

Log the underlying D1 failure via the injected logger and return a generic
`error_description` when media metadata insert fails, instead of relaying
the raw database error message verbatim to the client.
