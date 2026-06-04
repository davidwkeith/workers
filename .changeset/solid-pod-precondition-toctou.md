---
"@dwk/store": patch
"@dwk/solid-pod": patch
---

Fix a TOCTOU in `@dwk/solid-pod` write/delete preconditions (#29). Create-only
(`If-None-Match: *`) and `If-Match` were evaluated against `store.head()`
outside the write transaction, with an `await request.arrayBuffer()` between the
check and the transactional write — so two concurrent `PUT If-None-Match: *`
could both pass and both write, breaking the create-only guarantee.

`@dwk/store` now takes `ifNoneMatch` in `WriteOptions` and enforces both
preconditions inside the same `transactionSync` as the pointer write, and
`delete` accepts an optional in-transaction `guard`. `@dwk/solid-pod` threads
the request preconditions into the store write and re-checks LDP container
emptiness inside the delete transaction, closing the check-and-write gap.
