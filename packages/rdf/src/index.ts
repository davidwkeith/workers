import { Parser, Writer, type Quad } from "n3";

/**
 * `@dwk/rdf` — thin Turtle/JSON-LD parse and serialize layer over N3.js.
 *
 * Cross-standard reusable: plain-data inputs only, no Workers runtime
 * dependency. See `spec/packages/rdf.md`.
 */

/** Parse a Turtle (or N-Triples/N-Quads/TriG) document into quads. */
export function parseTurtle(input: string): Quad[] {
  return new Parser().parse(input);
}

/** Serialize quads back into a Turtle document. */
export function writeTurtle(quads: Quad[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer();
    writer.addQuads(quads);
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}

/**
 * Parse a JSON-LD document into quads.
 *
 * N3.js does not handle JSON-LD; the edge-compatible JSON-LD path is a tracked
 * decision (see `spec/open-questions.md`).
 *
 * @throws not implemented yet.
 */
export function parseJsonLd(_input: string): Promise<Quad[]> {
  throw new Error("@dwk/rdf: parseJsonLd is not implemented yet");
}

export type { Quad };
