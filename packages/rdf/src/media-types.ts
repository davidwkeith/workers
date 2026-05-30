/**
 * RDF media-type registry for content negotiation. Maps the RDF serializations
 * `@dwk/solid-pod` negotiates over to the internal format identifier used by
 * the Turtle ({@link ./turtle}) and JSON-LD ({@link ./jsonld}) code paths.
 */

/** Serialization formats this package can parse and write. */
export type RdfFormat = "Turtle" | "TriG" | "N-Triples" | "N-Quads" | "JSON-LD";

/** Canonical media type → format. Keys are lowercase essence (no parameters). */
export const MEDIA_TYPE_FORMATS: Readonly<Record<string, RdfFormat>> = {
  "text/turtle": "Turtle",
  "application/trig": "TriG",
  "application/n-triples": "N-Triples",
  "application/n-quads": "N-Quads",
  "application/ld+json": "JSON-LD",
  "application/json": "JSON-LD",
};

/**
 * Resolve a media type (with optional parameters / charset, any casing) to its
 * RDF format, or `undefined` when the media type is not an RDF serialization.
 */
export function formatForMediaType(mediaType: string): RdfFormat | undefined {
  const essence = mediaType.split(";")[0]?.trim().toLowerCase();
  return essence ? MEDIA_TYPE_FORMATS[essence] : undefined;
}
