---
"@dwk/atproto-pds": patch
---

Two review follow-ups to the spec-conformance pass:

- **Bound CAR-import block verification concurrency.** `importRepoFromCar`
  verified every block's content address with `Promise.all(blocks.map(…))`, which
  materialises one pending promise per block at once — tens of thousands on a
  large repo, whose closure/promise overhead is itself a cost against the Worker's
  128 MB ceiling. A small fixed pool of workers pulling from a shared cursor now
  caps in-flight digests while still parallelising the SHA-256s.
- **Memoise immutable repository config reads.** The signing curve and raw public
  key are fixed at genesis, so `AtprotoRepoObject` now caches them on the instance
  (like the account DID) instead of issuing a SQLite-KV read on every identity
  request.
