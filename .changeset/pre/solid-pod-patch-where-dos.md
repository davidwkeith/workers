---
"@dwk/solid-pod": patch
---

Bound the N3 Patch `solid:where` solver against CPU exhaustion (#36). The
conjunctive matcher built the full cartesian product of candidate bindings
(`N^k` for `k` all-variable `where` triples against an `N`-triple resource)
before checking for a single bind. Because N3 Patch runs inside the
single-threaded per-pod Durable Object, an authenticated `Append`/`Write`
client could submit a crafted patch that blew the CPU budget and stalled the
entire pod (DoS).

`solve` now caps the `where` triple count and the total candidate-match work
regardless of resource size, throwing `where_too_complex` (surfaced as `400`)
when either bound is exceeded, and short-circuits as soon as a second solution
appears — it only needs to distinguish "no bind", "exactly one bind", and
"ambiguous", not enumerate every solution.
