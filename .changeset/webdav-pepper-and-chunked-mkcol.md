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
check. The fix now reads (and discards) the first chunk of the body to check
for actual bytes rather than inferring emptiness from headers alone, so a
legitimate empty chunked-encoded MKCOL (a non-null body stream that simply
yields no bytes) is no longer rejected alongside a real one.
