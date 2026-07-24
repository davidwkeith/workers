# `@dwk/mf2`

HTML-embedded microformats2 (`h-entry`/`h-card`) extraction, built entirely on
the Cloudflare Workers runtime's `HTMLRewriter` — no bundled parser, zero
script-size cost.

```ts
import { parseHFeed, matchInteraction, sanitizeContentHtml } from "@dwk/mf2";

const entries = await parseHFeed(html, sourceUrl);

// Which entry (if any) targets a Webmention's `target` URL, and how.
const match = matchInteraction(entries, targetUrl);
if (match) {
  console.log(match.kind, match.entry.author, match.entry.content?.html);
}
```

Not a full mf2 engine — see [`spec/packages/mf2.md`](../../spec/packages/mf2.md)
for exactly what's extracted and the design constraints.

## Consumers

- [`@dwk/microsub`](../microsub) — `h-feed` polling for reader timelines.
- [`@dwk/webmention`](../webmention) — enriching received mentions with the
  sender's author/content/interaction-type.

## Development

See the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
