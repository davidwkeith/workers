# @dwk/mf2

Microformats2 `h-entry`/`h-card` extraction to [JF2](https://jf2.spec.indieweb.org/),
plus an allowlist HTML sanitizer for the captured content — built entirely on
the Workers runtime's streaming `HTMLRewriter`, so no parser or sanitizer
dependency enters the Worker bundle.

Shared by `@dwk/microsub` (`h-feed` reader timelines) and `@dwk/webmention`
(received-mention author/content/interaction-type enrichment).

Provides:

- `parseHEntries(html, baseUrl)` — a pragmatic `h-entry` extractor (not a full
  mf2 engine): `u-url`, `p-name`, `e-content` (plain text **and** inner HTML),
  `dt-published`, `p-author` / nested `h-card`, `u-photo`, `p-category`, and
  the response-post URLs `u-in-reply-to`, `u-like-of`, `u-repost-of`,
  `u-bookmark-of`. The captured content HTML is **unsanitized** — run it
  through `sanitizeHtml` before persisting or serving it.
- `sanitizeHtml(html, options)` — reduce untrusted UGC to a small formatting
  allowlist (`p br em strong b i code pre blockquote ul ol li del s a`):
  everything else is unwrapped (script/style-like subtrees dropped entirely),
  all attributes are stripped except a validated absolute `http(s)` `a[href]`,
  `rel="ugc nofollow"` is forced onto every surviving link, and output can be
  truncated on text length with open tags closed.
- `fnv1aBase36(input)` — the small stable hash behind JF2 fallback `_id`s,
  exported so consumers can derive matching stable ids.

`HTMLRewriter` is a workerd global, so the API is async and runtime-bound; on
Node hosts, `@dwk/cf-shims`'s `installHTMLRewriter()` provides the global.

See `spec/packages/mf2.md` for the full contract.
