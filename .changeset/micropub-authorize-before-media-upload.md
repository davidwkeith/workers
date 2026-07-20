---
"@dwk/micropub": patch
---

Authorize a `multipart/form-data` create before streaming its files to R2
(#290). Previously the Micropub endpoint parsed the multipart body — including
`env.MEDIA.put(...)` for every uploaded file — before the authorization check,
so an unauthenticated caller could write arbitrary blobs to R2 (and orphan
them) simply by POSTing multipart bodies, an unauthenticated storage-exhaustion
and cost-amplification vector. The handler now parses only the text fields
up front (memory is still capped by the existing `Content-Length` guard) and
defers every file upload until after `authorize` succeeds. The dedicated media
endpoint already authorized first and is unchanged.
