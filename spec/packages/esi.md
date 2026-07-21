# `@dwk/esi`

|                 |                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------- |
| **Type**        | lib (cross-standard reusable)                                                                |
| **Ships a DO?** | no                                                                                            |
| **Used by**     | no `@dwk` endpoint package yet — a general-purpose primitive a composed Worker calls directly |

A streaming **Edge Side Includes** processor: a composed Worker calls
`processEsi` on its own outgoing `Response` to resolve
`<esi:include>`/`<esi:comment>`/`<esi:remove>` markup, splicing in fragments
fetched concurrently through [`@dwk/safe-fetch`](safe-fetch.md). The repo's
model is a mostly-static shell (Anglesite-generated HTML, cacheable at
Cloudflare's edge) composed with a Worker that owns the dynamic bits — ESI is
the standard mechanism for "cache the shell, refresh the fragment." A
**cross-standard reusable**: no IndieWeb/Solid assumptions, no Cloudflare
bindings, no Workers runtime dependency (pure over the Fetch/Streams API —
`Response`, `ReadableStream`, `TransformStream`, `TextEncoder`/`TextDecoder`
— so it unit-tests entirely under Node).

@see `docs/superpowers/specs/2026-07-13-esi-design.md` for the full design
rationale; issue [#247](https://github.com/davidwkeith/workers/issues/247).

## Functional requirements

- **`processEsi(response, options?)`** — the public entry point. Scans a
  `Response` whose `Content-Type` is textual (`text/html`, `text/plain`,
  `application/xhtml+xml`) and returns a new `Response` with the same
  status/headers and a transformed, still-streamed body. Any other content
  type (images, JSON APIs, ...) passes through **untouched** — same object,
  no fetch attempted. `Content-Length`, `ETag`, and `Last-Modified` are
  stripped from the transformed response: none of the three still describe
  the transformed body, and carrying them through unchanged would let a
  client's conditional request (`If-None-Match`/`If-Modified-Since`)
  validate against bytes that never actually matched what was served,
  serving a stale cached representation on a `304`. `processEsi` does not
  otherwise touch `cache-control` or any other header — the composed
  shell's cache policy is the caller's decision, not this library's (the one
  deliberate divergence from the Cloudflare reference implementation this
  package supersedes, which force-sets `cache-control: max-age=0`).
- **Supported markup (v1)** — a pragmatic subset of the
  [ESI Language Specification 1.0](https://www.w3.org/TR/esi-lang), not the
  full spec:
  - `<esi:include src="…" alt="…"? onerror="continue"?/>` — fetch `src`
    through `@dwk/safe-fetch` and splice the fragment body in place.
    `src`/`alt` are resolved against `options.baseUrl` before validation; an
    unresolvable relative URL with no `baseUrl` configured is treated as a
    fragment failure, not silently ignored. A fragment whose `Content-Type`
    is not textual/markup-ish is also treated as a failure — a declared
    binary type is never spliced into an HTML stream. On failure:
    - `onerror="continue"` → drop silently (empty string), log at `debug`.
    - no `onerror`, `alt` present → retry once against `alt`; still failing
      → drop silently, log at `warn`.
    - no `onerror`, no `alt` → drop silently, log at `warn`.
    - A composed page must never `5xx` because a fragment failed —
      availability over strictness.
  - `<esi:comment text="…"/>` — no-op, removed from output.
  - `<esi:remove>…</esi:remove>` — the block and its contents are stripped
    from output entirely; the block's own text is never buffered as a
    whole (only a marker token is produced), so a remove block of any size
    costs only its closing tag's length in pending memory.
  - **Explicitly out of scope for v1** (not silently missing):
    `esi:choose`/`esi:when`/`esi:otherwise`, `esi:vars`,
    `esi:try`/`esi:attempt`/`esi:except`, and ESI's expression language.
    Widening the subset later does not change the public API.
- **`createEsiTransformStream(options?)`** — the underlying
  `TransformStream<Uint8Array, Uint8Array>`, exported for a caller that wants
  to compose it directly rather than go through `processEsi`'s
  `Response`-level wrapper.
- **`EsiTokenizer`** — the incremental tokenizer (`push`/`flush`), exported
  for direct use/testing independent of the stream plumbing.
- **`resolveFragment`** — resolves a single `include` token to its
  spliced-in text per the `onerror`/`alt` rules above; never throws.

## Streaming design

- **One `TextDecoder({ stream: true })` per response, not per chunk.** A
  multi-byte UTF-8 character can straddle a chunk boundary; the decoder's
  `stream: true` mode carries a partial trailing byte sequence forward
  internally, but only if the same instance sees every chunk in order.
- **The tokenizer's "possible partial tag" buffer is capped** at 8192
  **bytes** (`MAX_PENDING_BYTES`), measured by UTF-8 byte length, not the
  JS string's own `.length` (UTF-16 code units) — a multi-byte-heavy payload
  (CJK text, emoji) would otherwise let the buffer grow well past the
  intended byte budget before the cap noticed, since a 3-byte-per-character
  CJK string is only 1 UTF-16 unit per character. Past the cap, the buffered
  text is flushed as literal text and scanning resumes — the same
  "degrade to pass-through" behavior malformed markup already gets, never a
  thrown error.
- **Fragment concurrency is bounded** (`options.concurrency`, default 6) by
  a counting semaphore; **output order is preserved** regardless of fetch
  completion order (a promise chain serializes emission, not the fetches
  themselves).
- **Backpressure:** `maxBufferedChunks` (default 256) is a soft high-water
  mark on scheduled-but-not-yet-emitted output chunks; once exceeded (e.g. a
  slow head-of-line fragment holding up the ordered tail), `transform` stops
  accepting input until the tail drains, so the origin body is not buffered
  unboundedly.
- **`maxIncludes`** (default 50 — Cloudflare Workers' free-tier subrequest
  ceiling) caps distinct `<esi:include>` tags processed per response; extras
  are dropped like any other fragment failure (logged at `warn`, never
  silently truncated past the log line).
- Per `spec/non-functional-requirements.md`'s runtime budget: this must
  never buffer the whole body — only the small, explicitly bounded
  "possible partial tag" tail buffer, plus the (capped, individually small)
  fragment bodies in flight at once.

## Security

- An `<esi:include src="…">`'s `src` may originate from content an end user
  authored (e.g. a Micropub note echoed back into a templated page), so it
  is exactly the "attacker- or user-supplied URL" case `@dwk/safe-fetch`'s
  doc comment describes. `processEsi` never bypasses `safeFetch`'s SSRF
  guard — there is no "trust this URL" escape hatch in `EsiOptions`.
- **Host-only logging.** A fragment `src`/`alt` MUST NOT reach a log line in
  full — only its host, via `@dwk/log`'s `hostFromUrl`, matching every other
  package's redaction rule for attacker- or user-supplied URLs.

## Design constraints

- **Pure, runtime-agnostic library.** No Cloudflare bindings, no Workers
  runtime dependency; unit-tests entirely under Node
  (`environment: "node"`).
- **No SSRF guard of its own.** Depends on [`@dwk/safe-fetch`](safe-fetch.md)
  (`safeFetch`, `readBodyCapped`) for every fragment fetch rather than
  re-deriving one.
- **Not a `createX(config)` endpoint factory.** `processEsi` is a pure
  response transform, not a routed handler — it doesn't fit the composition
  contract's endpoint-factory shape because it isn't an endpoint; a
  consuming Worker calls it on its own outgoing response, the same way it
  might call `readBodyCapped` on an inbound one.
- **ESM-only**, tree-shakeable, fully typed, dependencies minimized
  (`@dwk/log`, `@dwk/safe-fetch`).

## Testing

- Tokenizer: fixtures covering all three tags, self-closing vs.
  attribute-order variance, a tag split across simulated chunk boundaries,
  nested/malformed markup (degrades to pass-through, never throws), the
  byte-vs-code-unit pending-buffer cap, and plain text with no ESI markup at
  all (`processEsi` must be a no-op, not merely correct).
- Fragment fetch/error paths: `onerror="continue"`, `alt` retry-then-drop,
  no-`onerror`-no-`alt` drop, non-textual fragment `Content-Type` drop,
  over-`maxIncludes` drop, over-`concurrency` scheduling, an SSRF block from
  `@dwk/safe-fetch` propagating as a dropped fragment (not a thrown error
  out of `processEsi`), and host-only log fields.
- Streaming integration: a multi-fragment fixture response run end-to-end
  through `processEsi`, asserting the final stitched text, preserved output
  order under out-of-order fragment resolution, and stripped
  `Content-Length`/`ETag`/`Last-Modified` on the transformed response.
