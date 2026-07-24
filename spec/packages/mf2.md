# `@dwk/mf2`

| | |
|---|---|
| **Type** | standard-specific lib (IndieWeb, HTML-embedded microformats2) |
| **Ships a DO?** | no — pure extraction functions, `HTMLRewriter`-bound |
| **Standard** | [Microformats2](https://microformats.org/wiki/microformats2) (`h-entry` / `h-card`, HTML-embedded) |
| **Status** | proposed — tracked in [#412](https://github.com/davidwkeith/workers/issues/412) |

Extracts `h-entry` / `h-card` microformats2 markup embedded in a fetched HTML
page into [JF2](https://jf2.spec.indieweb.org/) shape. Built entirely on the
Workers runtime's built-in `HTMLRewriter` — no bundled parser — so it costs
nothing against the script-size budget
([non-functional-requirements.md](../non-functional-requirements.md)). It is a
**pragmatic extractor of the common properties**, not a full mf2 engine: `u-url`,
`p-name`, `e-content`, `dt-published`, `p-author` / nested `h-card`, `u-photo`,
`p-category`, and the four "of" reply-context properties `u-in-reply-to`,
`u-like-of`, `u-repost-of`, `u-bookmark-of`.

**Not the same concern as [`@dwk/micropub`](micropub.md)'s `mf2.ts`.** That
module normalizes the mf2-**JSON** wire format Micropub clients POST
(`{type, properties}`) — a data-shape transform with no HTML involved. This
package extracts mf2 **embedded in someone else's HTML** via a streaming
parse. They share the "microformats2" name and nothing else; do not merge them.

## Decision

Extracted from [`@dwk/microsub`](microsub.md)'s `hfeed.ts`, which implemented
this extractor first (to turn a followed `h-feed` source into timeline
entries) and already used the zero-bundle-cost `HTMLRewriter` approach. When
[`@dwk/webmention`](webmention.md) needed the same capability — extracting a
replying/liking/reposting/bookmarking sender's `h-entry` so a received
interaction can be enriched with real author/content, rather than staying an
anonymous `(source, target)` pair — duplicating the extractor was rejected in
favor of sharing it, the same reasoning [`@dwk/ldn`](ldn.md) already applied to
LDN's discovery/receiver/consumer primitives.

## What ships

- **`parseHFeed(html, baseUrl): Promise<Jf2Entry[]>`** — walks the document for
  every `h-entry` (optionally nested inside an `h-feed`, though nesting is not
  required) and returns them in document order. A `p-author` / bare nested
  `h-card` attaches as that entry's `author`. Values follow the mf2 `u-*` /
  `dt-*` attribute-first rule: `u-*` prefers `href`/`src`/`data`/`poster`,
  `dt-*` prefers `datetime`/`value`, both fall back to element text; `p-*` and
  `e-*` always use text content (see "Content" below for `e-content`
  specifically). The first value wins for singular properties; `photo` and
  `category` accumulate.
- **`Jf2Entry` / `Jf2Author` / `Jf2Content`** — the same JF2-shaped types
  `@dwk/microsub` already publishes; moving here makes this package their
  canonical home. `Jf2Entry` gains `"repost-of"` and `"bookmark-of"` fields
  (new — `hfeed.ts` only had `"in-reply-to"` / `"like-of"`).
- **`matchInteraction(entries, targetUrl): { entry: Jf2Entry; kind: "reply" | "repost" | "like" | "bookmark" } | null`** —
  new helper for the webmention use case: finds the entry (if any) whose
  `in-reply-to` / `repost-of` / `like-of` / `bookmark-of` resolves to
  `targetUrl`, and which "of" property matched. Precedence when an entry
  implausibly carries more than one matching property: reply > repost > like >
  bookmark. Returns `null` when no entry targets the URL (a bare link mention).
- **`sanitizeContentHtml(html): string`** — allowlist HTML sanitizer, also
  built on `HTMLRewriter` (no external sanitizer dependency): keeps
  `p br em strong b i code pre blockquote ul ol li del s a`, strips every
  attribute except `a`'s `href`, and forces `rel="ugc nofollow"` onto every
  surviving `a`. Received `e-content` is untrusted third-party markup — this
  closes the SEO/spam-link vector inherent in surfacing someone else's HTML
  ([non-functional-requirements.md](../non-functional-requirements.md) treats
  outbound-facing untrusted input the same way `@dwk/safe-fetch` treats
  outbound-facing untrusted URLs). Not every element is allowed — images,
  headings, and tables are dropped rather than preserved; widening the
  allowlist is tracked separately in
  [#413](https://github.com/davidwkeith/workers/issues/413).

## Content: HTML, not text

Unlike `hfeed.ts`'s original `Jf2Content` (`{ text }` only, tags stripped by
`HTMLRewriter`'s text accumulation), this package's `e-content` extraction
preserves the element's inner HTML and exposes it as `Jf2Content.html`,
already run through `sanitizeContentHtml`. `Jf2Content.text` remains available
as a tag-stripped fallback for consumers that only want plain text (Microsub
timelines, which render into reader clients that expect plain/summary text).

## Consumers

- **[`@dwk/microsub`](microsub.md)** — switches from its local `hfeed.ts` to
  this package for `h-feed` polling; existing behavior and tests are expected
  to carry over unchanged (`text` content, `in-reply-to`/`like-of` only — it
  has no use for `matchInteraction` or the new "of" properties).
- **[`@dwk/webmention`](webmention.md)** — new consumer. During asynchronous
  verification (`verify.ts`, the same fetch pass `extractRsvp` already runs
  in), parses the source body with `parseHFeed` and looks up
  `matchInteraction` against the target URL to enrich the stored mention with
  `interactionType`, `author`, sanitized `content`, and `published`. See
  webmention's own spec for how this feeds `ReceivedInteraction` snapshots
  (Anglesite's [C.3 canonicality
  decision](https://github.com/Anglesite/Anglesite-app/blob/main/docs/specs/2026-06-29-c3-received-interaction-canonicality.md)).

## Design constraints

- **HTML-embedded mf2 only, not a full engine.** No `rel=` parsing, no
  `include`/`implied` properties beyond what's listed above, no non-`h-entry`
  vocabularies (`h-event`, `h-recipe`, …). Widen deliberately, per consumer
  need, not speculatively.
- **Zero script-size cost.** `HTMLRewriter` only — no bundled HTML parser or
  sanitizer library. This is the reason the package exists as a shared unit
  rather than each consumer reaching for an npm mf2 parser independently.
- **Protocol-agnostic beyond HTML.** Takes an HTML string and a base URL in,
  returns plain data out — no Cloudflare bindings, no fetch. Callers own
  fetching the source (through `@dwk/safe-fetch` where the URL is
  attacker-influenced, as both current consumers already do).

## Conformance / testing

No hosted conformance suite (this is an internal extraction primitive, not a
standard with its own endpoint). Colocated unit tests over fixture HTML cover
each property, nested `h-card` authorship, the "of" precedence rules in
`matchInteraction`, and the sanitizer's allowlist/attribute-stripping/
`rel="ugc nofollow"` behavior — including adversarial fixtures (script tags,
disallowed elements, `javascript:` hrefs, malformed nesting) since this is the
one place in the cohort that turns untrusted third-party HTML back into markup
another page renders.
