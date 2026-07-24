---
"@dwk/mf2": minor
"@dwk/microsub": minor
"@dwk/webmention": minor
---

Add `@dwk/mf2` — HTML-embedded microformats2 (`h-entry`/`h-card`) extraction,
built entirely on the Workers runtime's `HTMLRewriter` (zero script-size cost,
no bundled parser) — and wire `@dwk/microsub` and `@dwk/webmention` to consume
it (#412), so `@dwk/webmention` can enrich received mentions with real
author/content/interaction-type data instead of an anonymous `(source,
target)` pair (unblocks Anglesite-app#362).

- **`@dwk/mf2`** extracts `h-entry` items into JF2 shape — `u-url`, `p-name`,
  `e-content`, `dt-published`, `p-author`/nested `h-card`, `u-photo`,
  `p-category`, and the four "of" reply-context properties
  `u-in-reply-to`/`u-like-of`/`u-repost-of`/`u-bookmark-of` (`hfeed.ts`, moved
  out of `@dwk/microsub` and extended with the last two). `matchInteraction`
  finds the entry (if any) targeting a given URL and which "of" property
  matched, with reply > repost > like > bookmark precedence.
  `sanitizeContentHtml` is a capture-time allowlist HTML sanitizer (also
  `HTMLRewriter`-based, no external dependency): keeps
  `p br em strong b i code pre blockquote ul ol li del s a`, strips every
  attribute except `a`'s `href` (validated `http`/`https`, resolved against
  the source's URL), and forces `rel="ugc nofollow"` onto every surviving
  link — received content is untrusted third-party HTML, so nothing
  unsanitized ever reaches a caller's storage. Images, headings, and tables
  are dropped rather than preserved (tracked follow-up: #413).
- **`@dwk/microsub`** now consumes `@dwk/mf2`'s `parseHFeed` for `h-feed`
  polling instead of its own copy; `Jf2Content` gains an `html` field
  alongside the existing tag-stripped `text`. Behavior is otherwise
  unchanged — feed-format normalisation (JSON Feed/Atom/RSS) stays in
  `@dwk/microsub`'s own `jf2.ts`.
- **`@dwk/webmention`** runs `@dwk/mf2` during the same asynchronous
  verification fetch `extractRsvp` already uses: a matched entry enriches the
  stored mention with `interactionType` (`reply`/`repost`/`like`/`bookmark`,
  or `mention` for a bare linking source with no matching entry),
  `author` (`name`/`url`/`photo`), sanitized `content` (truncated to ~500
  chars), and `publishedAt` (falling back to the verification time when the
  source has no `dt-published`). The inbox gains a stable `id`
  (`wm-{hash(source, target)}`) and nullable columns for the new fields,
  migrated additively on existing inboxes (same pattern as the `rsvp`
  column). `VerifiedMention`, `VerifyResult`, and the `webmention_list_received`
  MCP tool output all carry the new fields.
