import { formatForMediaType } from "./media-types";
import { parseJsonLd, writeJsonLd } from "./jsonld";
import { parseTurtle, writeTurtle } from "./turtle";
import type { Quad } from "n3";

/**
 * `@dwk/rdf` — thin Turtle/JSON-LD parse and serialize layer over N3.js.
 *
 * Cross-standard reusable: plain-data inputs only, no Workers runtime
 * dependency. See `spec/packages/rdf.md`.
 */

export {
  parseTurtle,
  writeTurtle,
  type ParseTurtleOptions,
  type WriteTurtleOptions,
} from "./turtle";

export {
  parseJsonLd,
  writeJsonLd,
  JsonLdError,
  type ParseJsonLdOptions,
  type WriteJsonLdOptions,
  type JsonValue,
  type JsonObject,
} from "./jsonld";

export {
  formatForMediaType,
  MEDIA_TYPE_FORMATS,
  type RdfFormat,
} from "./media-types";

export {
  termToStored,
  storedToTerm,
  quadToStored,
  storedToQuad,
  type StoredTerm,
  type StoredQuad,
  type StoredTermType,
} from "./store";

export type { Quad };

/** Options for {@link parse} / {@link serialize}. */
export interface NegotiationOptions {
  /** Base IRI used to resolve relative IRIs (Turtle family + JSON-LD). */
  readonly baseIRI?: string;
  /** Prefixes to declare when serializing the Turtle family. */
  readonly prefixes?: Record<string, string>;
}

/**
 * Parse an RDF document by media type — the content-negotiation entry point for
 * `@dwk/solid-pod`. Dispatches to the Turtle family or JSON-LD code path.
 *
 * @throws if the media type is not a supported RDF serialization.
 */
export async function parse(
  input: string,
  mediaType: string,
  options?: NegotiationOptions,
): Promise<Quad[]> {
  const format = formatForMediaType(mediaType);
  if (!format) {
    throw new Error(`@dwk/rdf: unsupported media type "${mediaType}"`);
  }
  if (format === "JSON-LD") {
    return parseJsonLd(input, { base: options?.baseIRI });
  }
  return parseTurtle(input, { format, baseIRI: options?.baseIRI });
}

/**
 * Serialize quads by media type — the content-negotiation entry point for
 * `@dwk/solid-pod`. Dispatches to the Turtle family or JSON-LD code path.
 *
 * @throws if the media type is not a supported RDF serialization.
 */
export async function serialize(
  quads: Quad[],
  mediaType: string,
  options?: NegotiationOptions,
): Promise<string> {
  const format = formatForMediaType(mediaType);
  if (!format) {
    throw new Error(`@dwk/rdf: unsupported media type "${mediaType}"`);
  }
  if (format === "JSON-LD") {
    return writeJsonLd(quads);
  }
  return writeTurtle(quads, { format, prefixes: options?.prefixes });
}
