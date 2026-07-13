# `@dwk/esi` — Edge Side Includes processor — design

Tracks [#247](https://github.com/davidwkeith/workers/issues/247).

## Problem

#247 asks for "support for Edge Side Includes," linking Cloudflare's
[2019 blog post](https://blog.cloudflare.com/edge-side-includes-with-cloudflare-workers/)
showing a Worker that scans a response body for `<esi:include src="…"/>` tags,
fetches each fragment, and stitches the results back into the stream before it
reaches the client. That reference implementation is a proof of concept, not a
library: it recognizes exactly one tag, fetches fragments **serially** while
streaming, ignores `onerror`, has no SSRF protection on the fragment URLs, and
unconditionally forces `cache-control: max-age=0` on every response it
touches.

The repo's model is a mostly-static shell (Anglesite-generated HTML,
cacheable at Cloudflare's edge) composed with a Worker that owns the dynamic
bits (webmention counts, a microsub unread badge, activitypub follower
stats — see `spec/overview.md` §4). ESI is the standard mechanism for
"cache the shell, refresh the fragment": Anglesite's static build emits
`<esi:include>` markup at the points where a page needs live data, and the
composed Worker resolves those tags at the edge before the response goes out.
The issue's own body flags that the *producing* side (Anglesite emitting the
tags) is a separate feature to file against `Anglesite/Anglesite-app`; this
design covers only the **processing** side that belongs in this repo.

## Goal

A new cross-standard reusable lib, `@dwk/esi`, that any composed Worker
(inside or outside this repo) can call on an outgoing `Response` to resolve
`<esi:include>` fragments — properly streamed, fragment fetches routed
through `@dwk/safe-fetch` for SSRF protection, concurrent instead of serial,
and without the reference implementation's cache-control and error-handling
shortcuts. No specific `@dwk` package is a required consumer yet (per the
scoping conversation on #247): this lands as a general-purpose primitive, the
same tier as `@dwk/safe-fetch` itself. Which endpoint packages' fragments get
`esi:include`d, and the Anglesite-side markup generation, are separate
follow-up work (Anglesite issue + whichever package wiring is decided later).

## Package: `@dwk/esi`

New package at `packages/esi/`, same tier and shape as `@dwk/safe-fetch`:
pure over the Fetch/Streams API (`Response`, `ReadableStream`,
`TransformStream`, `TextEncoder`/`TextDecoder` — all available under Node,
same as `@dwk/safe-fetch`'s own tests), no Cloudflare bindings, `"type":
"module"`, `"sideEffects": false`, ESM `exports` map, ships `dist` + `src`
(minus tests), Node-testable (`environment: "node"` in `vitest.config.ts`).
Depends on `@dwk/log` (injectable `Logger`/`Metrics`, matching every other
package) and `@dwk/safe-fetch` (`safeFetch`, `readBodyCapped`) — it does not
re-derive its own SSRF guard or body cap.

### Supported markup (v1)

The [ESI Language Specification 1.0](https://www.w3.org/TR/esi-lang) is
large; matching the repo's pattern of shipping a pragmatic, documented subset
rather than the full spec (see the JSON-LD subset decision in
`spec/open-questions.md` §4), v1 supports exactly three tags:

- **`<esi:include src="…" alt="…"? onerror="continue"?/>`** — fetch `src`
  (through `@dwk/safe-fetch`) and splice the fragment body in place. If the
  fetch fails or returns a non-2xx status:
  - `onerror="continue"` → drop the tag silently (replace with empty string),
    log at `debug`.
  - no `onerror`, `alt` present → retry once against `alt`; if that also
    fails, drop silently and log at `warn`.
  - no `onerror`, no `alt` → drop silently, log at `warn`.
  - (Matches the ESI spec's intent for `onerror`/`alt` but is stricter than
    the reference blog post, which parses `onerror` and does nothing with
    it.) A composed page must never 5xx because a fragment failed —
    availability over strictness.
- **`<esi:comment text="…"/>`** — no-op, removed from output. (Lets template
  authors leave notes in ESI markup that never reach a client, same intent as
  the spec.)
- **`<esi:remove>…</esi:remove>`** — the block and its contents are stripped
  from output entirely. (Standard ESI idiom for "fallback markup to show only
  when ESI isn't processed at all," e.g. static placeholder content in a
  no-ESI preview.)

**Explicitly out of scope for v1** (documented here, not silently missing):
`esi:choose`/`esi:when`/`esi:otherwise` (conditional logic), `esi:vars`
(cookie/variable substitution), `esi:try`/`esi:attempt`/`esi:except`
(fallback blocks beyond plain `alt`), and any of ESI's expression language.
None of these are needed for the "splice a live fragment into a cached
shell" use case that motivates #247; widening the subset later does not
change the public API, same rationale as the JSON-LD precedent.

### API

```ts
export interface EsiOptions {
  /** Underlying fetch to use for fragments; defaults to global fetch. */
  readonly fetch?: FetchLike; // from @dwk/safe-fetch
  /** Passed through to every fragment's safeFetch call. */
  readonly safeFetchOptions?: SafeFetchOptions;
  /** Cap on a single fragment body (default: @dwk/safe-fetch's MAX_BODY_BYTES). */
  readonly maxFragmentBytes?: number;
  /** Cap on distinct <esi:include> tags processed per response (default 50 —
   *  Cloudflare Workers' free-tier subrequest ceiling; configurable up for
   *  paid plans). Extra includes beyond the cap are dropped like any other
   *  fragment failure (logged at `warn`, not silently truncated). */
  readonly maxIncludes?: number;
  /** How many fragment fetches run concurrently (default 6). */
  readonly concurrency?: number;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

/**
 * Resolve <esi:include>/<esi:comment>/<esi:remove> markup in `response`'s
 * body, returning a new Response with the same status/headers (except
 * Content-Length, which no longer applies to a streamed body) and a
 * transformed, still-streamed body. Non-text content types pass through
 * untouched. Does not alter cache-control — callers set whatever caching
 * policy they want on the outer response themselves.
 */
export function processEsi(response: Response, options?: EsiOptions): Response;
```

`processEsi` is a pure response transform, not a `createX(config)` handler —
it doesn't fit the composition contract's endpoint-factory shape because it
isn't a routed endpoint; a consuming Worker calls it on its own outgoing
response, the same way it might call `readBodyCapped` on an inbound one.

### Streaming design

Same shape as the reference implementation's chunk boundary handling
(buffer until a `<`/`>` pair completes, so a tag is never split across two
stream chunks) but replacing its single regex pass with a small tokenizer
that recognizes all three supported tags (including `esi:remove`'s block
form, which a single-line regex can't safely handle) and treats anything else
as opaque pass-through text. `<esi:include>` fragment fetches launch as soon
as their tag is recognized and are awaited (bounded by `concurrency`) before
the transform emits that position in the stream — no fragment is fetched
after the fact once the response has started flushing past it, and fragments
before a slow one still don't block index order (results are held until
their turn, not necessarily returned in fetch-completion order).

Per `spec/non-functional-requirements.md`'s runtime budget: this must never
buffer the whole body — only the small "possible partial tag" tail buffer
that the reference implementation also needs, plus the (capped,
individually small) fragment bodies in flight at once.

### Security

An `<esi:include src="…">`'s `src` may originate from content an end user
authored (e.g. a Micropub note that got echoed back into a templated page),
so it is exactly the "attacker- or user-supplied URL" case
`@dwk/safe-fetch`'s doc comment describes. `processEsi` never bypasses
`safeFetch`'s SSRF guard — there is no "trust this URL" escape hatch in
`EsiOptions`.

### Content-type gating

Only `Response`s whose `Content-Type` is textual (`text/html`,
`text/plain`, `application/xhtml+xml`) are scanned; anything else (images,
JSON APIs, etc.) passes through with an untouched body, mirroring the
reference implementation's `fetchAndStream` check.

### Cache-control — the one deliberate divergence from the reference impl

The blog post's Worker force-sets `cache-control: max-age=0` on every
response. `processEsi` does not touch `cache-control` (or any other header)
at all beyond removing `Content-Length` (streaming makes it inaccurate) —
the composed shell's cache policy is the caller's decision, not this
library's. Cloudflare Cache API / edge-cache integration (marking the shell
cacheable at Cloudflare while never browser-caching it) is a caller concern
and out of scope here.

## Testing plan

- `parse`/tokenizer: fixtures covering all three tags, self-closing vs.
  attribute-order variance, a tag split across simulated chunk boundaries,
  nested/malformed markup (must degrade to pass-through, never throw), and
  plain text with no ESI markup at all (`processEsi` must be a no-op, not
  merely correct — some callers will run every response through it
  unconditionally).
- Fragment fetch/error paths: `onerror="continue"`, `alt` retry-then-drop,
  no-`onerror`-no-`alt` drop, over-`maxIncludes` drop, over-`concurrency`
  scheduling, SSRF block from `@dwk/safe-fetch` propagating as a dropped
  fragment (not a thrown error out of `processEsi`).
- Streaming integration: a multi-fragment fixture response run end-to-end
  through `processEsi`, asserting the final stitched text and that no more
  than `concurrency` fetches are in flight at once (via a fetch stub that
  tracks concurrent call count).
- Content-type gate: JSON/image responses pass through with an identical
  body and no fragment fetches attempted.

## Release bookkeeping

- New package needs `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `README.md`, `src/index.ts` doc comment (`@see
  docs/superpowers/specs/2026-07-13-esi-design.md` — no `spec/packages/esi.md`
  is planned, matching `@dwk/safe-fetch`'s precedent of a design doc instead
  of a full per-package spec for a smaller reusable lib), and a
  `conformance/status.json` entry (`"standard": null`, empty `suites`,
  `"integration": {"status": "pending", "cases": []}`, same shape as
  `@dwk/safe-fetch`/`@dwk/dpop`/`@dwk/rdf`).
- A `pnpm changeset` for `@dwk/esi` (new package, minor).
- `CLAUDE.md`'s "Cross-standard reusable libs" list and package count get a
  new `@dwk/esi` entry.

## Explicitly not part of this design

- **Anglesite-side markup generation** — a separate feature request against
  `Anglesite/Anglesite-app`, per the issue body. This repo only ships the
  processor.
- **Which `@dwk` endpoint(s) get wired up as ESI fragment sources** — no
  consumer was chosen (scoped as "general-purpose" on #247); left for
  whoever integrates `@dwk/esi` into a composed Worker later.
- **Cloudflare's zone-level Enterprise ESI product** — unrelated; that's a
  cache-configuration feature, not something a Worker package implements.
