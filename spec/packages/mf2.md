# `@dwk/mf2`

|                 |                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Type**        | lib (standard-specific: microformats2 is an IndieWeb building block)                                                  |
| **Ships a DO?** | no                                                                                                                    |
| **Standard**    | [Microformats2](https://microformats.org/wiki/microformats2) (`h-entry` / `h-card`), output shaped as [JF2](https://jf2.spec.indieweb.org/) |
| **Used by**     | [`@dwk/microsub`](microsub.md) (`h-feed` reader timelines), [`@dwk/webmention`](webmention.md) (received-mention enrichment) |

The shared microformats2 reader (issue #412). Extracted from `@dwk/microsub`'s
`hfeed.ts` — which had already solved bounded, zero-bundle-cost `h-entry`
extraction for reader timelines — so `@dwk/webmention` can enrich received
mentions with author/content/interaction data instead of reinventing the
parse. Everything runs on the runtime's built-in streaming `HTMLRewriter`: no
bundled parser or sanitizer dependency ever enters the Worker script
([non-functional-requirements.md](../non-functional-requirements.md)).

Unlike the pure plain-data libs (`@dwk/rdf`, `@dwk/dpop`, …) this package is
**runtime-bound**: `HTMLRewriter` is a workerd global, so the API is async and
the tests run under the Workers pool. On Node hosts the
[`@dwk/cf-shims`](cf-shims.md) `installHTMLRewriter()` polyfill provides the
global.

## Functional requirements

### `parseHEntries(html, baseUrl)` — `h-entry` → JF2

- Extract every `h-entry` (usually inside an `h-feed`) into a JF2 `entry`, in
  document order; `[]` when the document has none.
- **Pragmatic property coverage, not a full mf2 engine:** `u-url`, `p-name`,
  `e-content`, `dt-published`, `p-author` / nested `h-card`
  (`p-name`/`u-url`/`u-photo`), `u-photo`, `p-category`, and the
  response-post URLs `u-in-reply-to`, `u-like-of`, `u-repost-of`,
  `u-bookmark-of` — together covering all five received-interaction kinds
  (reply / like / repost / bookmark / mention).
- `e-content` is captured **both** as plain text and as its inner HTML
  (reconstructed from the stream, entities preserved as written, capped so an
  attacker-sized page cannot balloon memory). The HTML is **unsanitized** —
  consumers MUST run it through `sanitizeHtml` (or equivalent) before
  persisting or serving it.
- **Entity decoding on interpreted values:** this runtime's `HTMLRewriter`
  hands back raw, undecoded text and attribute values, so every value the
  extractor *interprets* — URL-valued properties (a `u-in-reply-to` of
  `…?a=1&amp;b=2` MUST yield `…?a=1&b=2`), `dt-*` values, and plain-text
  properties — is decoded via `decodeEntities` (exported; the five predefined
  named entities plus numeric references, no bundled HTML5 entity table).
  Captured HTML stays encoded as written; re-serialized attributes decode
  then re-encode so they never double-escape.
- URL-valued properties resolve against `baseUrl` (the fetched document's
  final URL).
- Every entry carries a stable `_id`: its own `u-url`, else an
  `fnv1aBase36` hash of its name + content.

### `sanitizeHtml(html, options)` — allowlist UGC sanitizer

- Reduce untrusted HTML to the formatting allowlist
  `p br em strong b i code pre blockquote ul ol li del s a`. Tags outside the
  allowlist are unwrapped to their text; `script`/`style`-like subtrees are
  dropped entirely, text included.
- **All attributes are stripped** except `a[href]`, which must resolve
  (against `options.baseUrl`) to an absolute `http:`/`https:` URL — a
  `javascript:`/`data:`/unresolvable link is unwrapped. Every surviving link
  gets `rel="ugc nofollow"` forced onto it: received content is untrusted
  UGC, and this closes the SEO/spam-link vector.
- **Two element kinds are rewritten rather than unwrapped** (issue #413):
  - `<img>` becomes `<a href="src">alt</a>` — the same `href` validation and
    forced `rel` as any link, labeled by the decoded `alt` text (the resolved
    URL itself when `alt` is empty). An embedded image auto-fetches on every
    render of the stored snapshot, so a pass-through `src` would let received
    content beacon to attacker-controlled infrastructure; a link defers the
    fetch to a reader's click while keeping the photo reachable — and a
    photo-only reply no longer sanitizes to `""`. An `<img>` with no safe
    `src` keeps only its `alt` text; with neither, it is dropped.
  - Headings `h1`–`h6` demote to `<p><strong>…</strong></p>`: the emphasis
    survives, but a reply's markup can never claim a slot in — or out-rank —
    the embedding page's own heading hierarchy.
- `options.maxTextLength` truncates on text length with an ellipsis, never
  severing an entity, and closes any still-open tags; tags the *source* left
  unclosed are closed too, so stored fragments cannot leak formatting.
- No sanitizer dependency: the pass is a second `HTMLRewriter` scan.

### `fnv1aBase36(input)`

- The small, stable non-cryptographic hash (FNV-1a, base36) behind the
  fallback `_id`s, exported so consumers can derive matching stable ids
  (e.g. `@dwk/webmention`'s `wm-{hash}` mention ids).

## Non-requirements

- A full microformats2 parser (implied properties, `value-class`, `e-*`
  vocabularies beyond `e-content`, rel parsing). The runtime budget rules a
  full engine out of the Worker bundle; consumers needing full fidelity parse
  off-worker.
- The full HTML5 named-entity table: `decodeEntities` covers the predefined
  five plus numeric references; an exotic named reference (`&hellip;`) is
  left as written rather than pulling a data blob into the bundle.

## Testing

Colocated tests under the Workers pool (`HTMLRewriter` is a workerd global; no
bindings). `@dwk/microsub`'s pre-extraction `hfeed` tests were ported here
verbatim and must keep passing, alongside microsub's own unchanged suite.
