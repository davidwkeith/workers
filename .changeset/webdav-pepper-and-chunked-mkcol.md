---
"@dwk/webdav": patch
"@dwk/solid-pod": patch
---

`WEBDAV_PEPPER` is now actually mixed into the app-password hash (previously
declared as a binding but never read, so it did nothing). `@dwk/solid-pod`
now forwards it from its own `Env` into the `CredentialStore` it builds.

Also fixed: a MKCOL request body sent without a `Content-Length` header
(chunked transfer-encoding, whose length is unknown up front) previously
defaulted to "length 0" and slipped past the RFC 4918 §9.3 unsupported-media
check; only an explicit `Content-Length: 0` now clears a non-null body.
