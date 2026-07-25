# @dwk/mf2

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

## 0.1.0-beta.0

### Minor Changes

- 427064c: `sanitizeHtml` now rewrites `<img>` to a link to its `src` labeled by its
  `alt` text (same href validation and forced `rel="ugc nofollow"` as any
  link), so a photo reply no longer sanitizes to empty content while nothing
  in stored snapshots auto-fetches attacker-controlled URLs on render; and
  demotes headings `h1`–`h6` to `<p><strong>` bold paragraphs so received
  content can never out-rank the embedding page's own heading hierarchy.
  `@dwk/webmention` mention enrichment and `@dwk/microsub` timeline content
  pick up the new behavior at capture time.
- 55fa4c3: Extract the `h-entry` microformats extractor into a new shared lib, `@dwk/mf2`,
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

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
