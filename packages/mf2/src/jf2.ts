/**
 * `@dwk/mf2` — the JF2 output shapes and the stable-id hash.
 *
 * The extractor ({@link ./hentry}) normalises a document's `h-entry`
 * microformats into [JF2](https://jf2.spec.indieweb.org/) `entry` objects.
 * Everything here is plain data: consumers (`@dwk/microsub` timelines,
 * `@dwk/webmention` mention enrichment) share these shapes without sharing a
 * runtime.
 *
 * @packageDocumentation
 */

/** A JF2 author card. */
export interface Jf2Author {
  readonly type: "card";
  readonly name?: string;
  readonly url?: string;
  readonly photo?: string;
}

/** Structured JF2 content (`html` and/or its plain-text rendering). */
export interface Jf2Content {
  /**
   * The `e-content` element's inner HTML, reconstructed from the streaming
   * parse. **Unsanitized** — run it through {@link ../sanitize} (or an
   * equivalent) before persisting or serving it.
   */
  readonly html?: string;
  readonly text?: string;
}

/** A JF2 `entry` extracted from a document's microformats2. */
export interface Jf2Entry {
  readonly type: "entry";
  /**
   * Stable per-entry identifier: the entry's own `u-url` when it has one,
   * otherwise an {@link fnv1aBase36} hash of its name + content so re-parsing
   * the same document yields the same id.
   */
  readonly _id: string;
  readonly url?: string;
  readonly published?: string;
  readonly name?: string;
  readonly content?: Jf2Content;
  readonly author?: Jf2Author;
  readonly category?: readonly string[];
  readonly photo?: readonly string[];
  readonly "in-reply-to"?: string;
  readonly "like-of"?: string;
  readonly "repost-of"?: string;
  readonly "bookmark-of"?: string;
}

/**
 * A small, stable non-cryptographic hash (FNV-1a) rendered as base36. Used for
 * the fallback entry `_id`, and shared with consumers that need a stable id
 * derived from an entry-like key (e.g. `@dwk/webmention`'s `wm-{hash}` mention
 * ids).
 */
export function fnv1aBase36(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
