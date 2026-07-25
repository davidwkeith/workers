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
  need; no implied properties, no `value-class`.
- **Entities decode on interpreted values only.** `HTMLRewriter` hands back
  raw, undecoded text/attribute values, so URL/date/plain-text properties go
  through `decodeEntities` (predefined five + numeric refs — never the full
  HTML5 table); captured/emitted HTML stays encoded as written.
- **Captured content HTML is unsanitized by design** — extraction and
  sanitization are separate passes; consumers sanitize at capture time.
- **Consumers' behavior is the contract.** `@dwk/microsub`'s `hfeed`/timeline
  tests must keep passing unchanged against this extractor.
