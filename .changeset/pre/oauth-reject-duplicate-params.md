---
"@dwk/oauth": patch
---

Reject request bodies with a duplicated parameter (#308). `readForm` kept the
last occurrence of a repeated key while an `EndpointAuthenticator` reading the
cloned body sees the first (`FormData.get`), so two `client_id`s could
authenticate as one client but be attributed to another. Per RFC 6749 §3.2,
`readForm` now returns `null` on any duplicate and the introspection, revocation,
and PAR handlers reject it with `invalid_request`.
