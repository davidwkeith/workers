/**
 * `@dwk/mf2` — microformats2 extraction to JF2, plus an allowlist HTML
 * sanitizer for the captured content.
 *
 * Standard-specific lib (microformats2 is an IndieWeb building block), shared
 * by `@dwk/microsub` (h-feed reader timelines) and `@dwk/webmention`
 * (received-mention author/content/interaction-type enrichment). Built
 * entirely on the runtime's streaming `HTMLRewriter` — no bundled parser or
 * sanitizer dependency, zero script-size cost — which also means the parsing
 * helpers are async and runtime-bound (workerd, or a host installing an
 * `HTMLRewriter` global such as `@dwk/cf-shims`), unlike the pure plain-data
 * libs.
 *
 * @see spec/packages/mf2.md
 * @packageDocumentation
 */

export { parseHEntries } from "./hentry.js";
export {
  sanitizeHtml,
  SANITIZE_ALLOWED_TAGS,
  SANITIZE_LINK_REL,
  type SanitizeOptions,
} from "./sanitize.js";
export {
  fnv1aBase36,
  type Jf2Author,
  type Jf2Content,
  type Jf2Entry,
} from "./jf2.js";
