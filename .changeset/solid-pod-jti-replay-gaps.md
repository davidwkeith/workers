---
"@dwk/solid-pod": patch
"@dwk/store": patch
---

Close three DPoP `jti` replay-enforcement gaps in `@dwk/solid-pod` writes
(issue #34):

- **Replay TTL now covers the full proof-acceptance window.** `@dwk/dpop`
  accepts a proof whose `iat` lands anywhere in `±DEFAULT_MAX_AGE_SECONDS`, so a
  single proof stays valid across a `2 × DEFAULT_MAX_AGE_SECONDS` span. The
  replay row's TTL is anchored to that window (`2 × DEFAULT_MAX_AGE_SECONDS`)
  instead of a bare 5 minutes, so a row can no longer be pruned while its proof
  is still cryptographically acceptable.
- **A `jti` is consumed atomically with the write.** Replay consumption moved
  from before the write into the store's write `transactionSync`, after the
  `If-Match` / `solid:where` preconditions pass. A `412` (stale ETag) or `409`
  (patch no-match) now rolls the replay row back with the write, leaving the
  proof reusable for a legitimate retry instead of burning it. `@dwk/store`
  gains a transactional `guard` hook on `WriteOptions` (the existing delete
  guard) to support this.
- **Anonymous writes are gated by config.** A tokenless (proof-less) write
  carries no `jti` and therefore no replay / anti-abuse protection. Such a write
  is now refused `401` by default even where a public-write ACL
  (`acl:agentClass foaf:Agent`) would permit it; set the new
  `allowAnonymousWrites: true` to opt into public write as an explicit,
  documented tradeoff.
