---
"@dwk/esi": minor
---

Propagate backpressure in the ESI transform stream (#307). `transform` scheduled
each output chunk onto the ordered `tail` promise chain but returned
synchronously, so while a slow head-of-line `<esi:include>` fragment fetch (up to
the fragment timeout) held up the tail, the rest of the origin body kept being
pulled and buffered as pending output — unbounded, against the Worker's 128 MB
limit. `transform` now stops accepting input once more than `maxBufferedChunks`
(default 256, configurable) output chunks are scheduled but not yet emitted,
draining the tail before continuing. Fragment-fetch concurrency and output
ordering are unchanged.
