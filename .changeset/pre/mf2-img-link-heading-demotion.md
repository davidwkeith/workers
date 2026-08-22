---
"@dwk/mf2": minor
"@dwk/webmention": patch
"@dwk/microsub": patch
---

`sanitizeHtml` now rewrites `<img>` to a link to its `src` labeled by its
`alt` text (same href validation and forced `rel="ugc nofollow"` as any
link), so a photo reply no longer sanitizes to empty content while nothing
in stored snapshots auto-fetches attacker-controlled URLs on render; and
demotes headings `h1`–`h6` to `<p><strong>` bold paragraphs so received
content can never out-rank the embedding page's own heading hierarchy.
`@dwk/webmention` mention enrichment and `@dwk/microsub` timeline content
pick up the new behavior at capture time.
