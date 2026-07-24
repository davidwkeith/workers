# @dwk/mf2

Shared microformats2 extraction (h-entry → JF2) and allowlist HTML
sanitization.

## What this is

The `HTMLRewriter`-based `h-entry`/`h-card` extractor that used to live in
`@dwk/microsub`'s `hfeed.ts`, extracted (issue #412) so `@dwk/webmention` can
enrich received mentions with author/content/interaction-type data. Also ships
the allowlist sanitizer that captured `e-content` HTML must pass through
before persistence, and the FNV-1a/base36 stable-id hash.

## Spec

`spec/packages/mf2.md` — authoritative requirements.

## Key constraints

- **Zero bundled-parser cost.** Everything runs on the runtime's built-in
  streaming `HTMLRewriter` — never add an HTML parser or sanitizer dependency
  (`spec/non-functional-requirements.md`).
- **Runtime-bound lib.** Unlike the pure plain-data libs, `HTMLRewriter` is a
  workerd global: the API is async, tests run under the Workers pool, and
  Node hosts rely on `@dwk/cf-shims`'s `installHTMLRewriter()`.
- **Pragmatic, not a full mf2 engine.** Only the properties the consumers
  need; no implied properties, no `value-class`, no entity decoding.
- **Captured content HTML is unsanitized by design** — extraction and
  sanitization are separate passes; consumers sanitize at capture time.
- **Consumers' behavior is the contract.** `@dwk/microsub`'s `hfeed`/timeline
  tests must keep passing unchanged against this extractor.

## Test environment

Workerd via `@cloudflare/vitest-pool-workers` (no bindings — only the
`HTMLRewriter` global is needed).

```bash
pnpm test --project @dwk/mf2
```

## File layout

```
src/index.ts         # public surface
src/jf2.ts           # Jf2Entry/Jf2Author/Jf2Content shapes + fnv1aBase36
src/hentry.ts        # parseHEntries (h-entry/h-card extraction)
src/sanitize.ts      # sanitizeHtml (allowlist UGC sanitizer)
src/void-elements.ts # shared HTML void-element set
src/*.test.ts        # colocated tests
```

## Depended on by

`@dwk/microsub` (parseHFeed) and `@dwk/webmention` (mention enrichment), via
`workspace:*`.
