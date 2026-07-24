/**
 * `@dwk/mf2` — JF2 entry/author/content shapes.
 *
 * [JF2](https://jf2.spec.indieweb.org/) is the normalised entry shape this
 * package's `h-entry` extraction produces. `@dwk/microsub` also uses these
 * types for entries normalised from non-HTML feed formats (JSON Feed, Atom,
 * RSS) so its timeline is uniform regardless of source format — they are the
 * cohort's canonical JF2 shape, not solely this package's own return type.
 *
 * @see spec/packages/mf2.md
 * @packageDocumentation
 */

/** A JF2 author card. */
export interface Jf2Author {
  readonly type: "card";
  readonly name?: string;
  readonly url?: string;
  readonly photo?: string;
}

/**
 * Structured JF2 content. `html` is the entry's `e-content`, already run
 * through {@link sanitizeContentHtml} (see `./sanitize.js`) — safe to render
 * as-is. `text` is a tag-stripped plain-text rendering, for consumers that
 * have no use for markup (e.g. Microsub reader timelines).
 */
export interface Jf2Content {
  readonly html?: string;
  readonly text?: string;
}

/** A normalised JF2 timeline entry. */
export interface Jf2Entry {
  readonly type: "entry";
  /**
   * Stable per-entry identifier, derived from the source's own id/guid/url (or
   * a content hash when neither is present). Consumers key stored state on
   * this so re-processing a source does not duplicate entries.
   */
  readonly _id: string;
  readonly url?: string;
  readonly published?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly content?: Jf2Content;
  readonly author?: Jf2Author;
  readonly category?: readonly string[];
  readonly photo?: readonly string[];
  readonly "in-reply-to"?: string;
  readonly "like-of"?: string;
  readonly "repost-of"?: string;
  readonly "bookmark-of"?: string;
  /**
   * Read flag, attached by `@dwk/microsub`'s store on read (never by this
   * package's parser). Carried on the shared type rather than a microsub-local
   * extension so its existing `{ ...entry, _is_read }` spread keeps
   * type-checking unchanged.
   */
  readonly _is_read?: boolean;
}
