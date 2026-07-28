# @dwk/esi

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/log@1.0.0-beta.1
  - @dwk/safe-fetch@1.0.0-beta.1

## 0.1.0-beta.4

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [4cd36af]
  - @dwk/log@0.1.0-beta.5
  - @dwk/safe-fetch@0.1.0-beta.4

## 0.1.0-beta.3

### Minor Changes

- dec2fbe: Propagate backpressure in the ESI transform stream (#307). `transform` scheduled
  each output chunk onto the ordered `tail` promise chain but returned
  synchronously, so while a slow head-of-line `<esi:include>` fragment fetch (up to
  the fragment timeout) held up the tail, the rest of the origin body kept being
  pulled and buffered as pending output — unbounded, against the Worker's 128 MB
  limit. `transform` now stops accepting input once more than `maxBufferedChunks`
  (default 256, configurable) output chunks are scheduled but not yet emitted,
  draining the tail before continuing. Fragment-fetch concurrency and output
  ordering are unchanged.

### Patch Changes

- 3e505be: Fragment failure logs (`esi.fragment.failed`, `esi.include.dropped_max_includes`)
  now record only the host of a `src`/`alt` URL (via `@dwk/log`'s `hostFromUrl`)
  instead of the full URL, matching every other package's redaction rule for
  attacker- or user-supplied URLs.

  `processEsi` now strips `ETag` and `Last-Modified` from the transformed
  response alongside `Content-Length` — none of the three still describe the
  transformed body, and carrying `ETag`/`Last-Modified` through unchanged could
  serve a stale cached representation on a client's conditional request.

  The tokenizer's pending-tag buffer cap (`MAX_PENDING_BYTES`, 8192) is now
  measured by UTF-8 byte length instead of the JS string's own `.length`
  (UTF-16 code units) — a multi-byte-heavy payload (CJK text, emoji) could
  previously grow the buffer well past the intended byte budget before the cap
  noticed.

  Added `spec/packages/esi.md`, the only package previously missing one.

- Updated dependencies [0e65ce3]
- Updated dependencies [3e505be]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.2

### Minor Changes

- ecd2cd3: Add `@dwk/esi` — a streaming Edge Side Includes processor (`processEsi`)
  that resolves `<esi:include>`/`<esi:comment>`/`<esi:remove>` markup in a
  Response body, fetching fragments concurrently through `@dwk/safe-fetch`.

### Patch Changes

- Updated dependencies [6d14fc3]
- Updated dependencies [7b86416]
- Updated dependencies [22c802a]
  - @dwk/log@0.1.0-beta.3
  - @dwk/safe-fetch@0.1.0-beta.2
