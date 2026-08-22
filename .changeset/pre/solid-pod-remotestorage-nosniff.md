---
"@dwk/solid-pod": patch
"@dwk/remotestorage": patch
---

Blob/document GET and HEAD responses now carry
`X-Content-Type-Options: nosniff`. User-uploaded content is served back with
a user-supplied content type, and pods/accounts can expose public resources
without auth in front — without `nosniff` a mislabeled blob is a stored-XSS
vector on shared-origin deployments.
