/**
 * `@dwk/mf2` — HTML-embedded microformats2 (`h-entry`/`h-card`) extraction.
 *
 * Built entirely on the Workers runtime's `HTMLRewriter` — no bundled mf2
 * parser or HTML sanitizer, zero script-size cost. Shared by
 * `@dwk/microsub` (h-feed polling) and `@dwk/webmention` (enriching received
 * mentions with the sender's author/content/interaction-type).
 *
 * @see spec/packages/mf2.md
 * @packageDocumentation
 */

export { parseHFeed } from "./hfeed.js";
export type { Jf2Author, Jf2Content, Jf2Entry } from "./jf2.js";
export {
  INTERACTION_KINDS,
  matchInteraction,
  type InteractionKind,
  type MatchedInteraction,
} from "./interaction.js";
export { sanitizeContentHtml } from "./sanitize.js";
export { fnv1aBase36 } from "./hash.js";
