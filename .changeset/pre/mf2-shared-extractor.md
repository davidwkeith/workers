---
"@dwk/mf2": minor
"@dwk/microsub": minor
"@dwk/webmention": minor
---

Extract the `h-entry` microformats extractor into a new shared lib, `@dwk/mf2`,
and use it to enrich received Webmentions (#412).

- **`@dwk/mf2` (new):** `parseHEntries` — the `HTMLRewriter`-based `h-entry` /
  `h-card` → JF2 extractor moved out of `@dwk/microsub`'s `hfeed.ts` — now also
  recognizes `u-repost-of` / `u-bookmark-of` and captures `e-content` inner
  HTML alongside its text. Ships `sanitizeHtml`, an allowlist sanitizer for
  that captured UGC (formatting tags only, all attributes stripped except a
  validated `a[href]`, `rel="ugc nofollow"` forced onto surviving links,
  text-length truncation), `decodeEntities` (this runtime's `HTMLRewriter`
  hands back raw, undecoded values, so URL/date/plain-text properties decode
  before they are interpreted — an `href` of `…?a=1&amp;b=2` matches the
  target `…?a=1&b=2` — while captured HTML stays encoded), and
  `fnv1aBase36`, the stable-id hash.
- **`@dwk/microsub`:** consumes `@dwk/mf2` for `parseHFeed` instead of owning
  the extractor; behavior and public surface unchanged (`Jf2Entry` gains
  optional `repost-of` / `bookmark-of`).
- **`@dwk/webmention`:** verified mentions are enriched from the one `h-entry`
  responding to the target — `interactionType`
  (reply / like / repost / bookmark / mention, precedence reply > repost >
  like > bookmark), `author`, sanitized+truncated `content` HTML, and
  `publishedAt` (declared `dt-published`, else the verification time). The D1
  inbox gains additive nullable columns (`id`, `interaction_type`,
  `author_name`, `author_url`, `author_photo`, `content`, `published_at`) with
  the same `ALTER TABLE` migration pattern as `rsvp`; `id` is a stable
  `wm-{hash}` over `(source, target)` (exported as `mentionId`).
  `VerifiedMention`, `VerifyResult`, and the `webmention_list_received` MCP
  tool output all carry the new fields.
