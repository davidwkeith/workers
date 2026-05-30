import { Parser, Writer } from "n3";
import type { Quad } from "n3";

/**
 * Turtle-family (Turtle / TriG / N-Triples / N-Quads) parse and serialize over
 * N3.js. Plain-data inputs only — no Workers-runtime dependency.
 */

/** Options for {@link parseTurtle}. */
export interface ParseTurtleOptions {
  /**
   * N3.js format hint (e.g. `"Turtle"`, `"TriG"`, `"N-Triples"`, `"N-Quads"`).
   * When omitted, N3.js sniffs the format and defaults to Turtle/TriG.
   */
  readonly format?: string;
  /** Base IRI used to resolve relative IRIs in the document. */
  readonly baseIRI?: string;
}

/** Parse a Turtle (or N-Triples / N-Quads / TriG) document into quads. */
export function parseTurtle(
  input: string,
  options?: ParseTurtleOptions,
): Quad[] {
  return new Parser({
    format: options?.format,
    baseIRI: options?.baseIRI,
  }).parse(input);
}

/** Options for {@link writeTurtle}. */
export interface WriteTurtleOptions {
  /**
   * N3.js output format (e.g. `"Turtle"`, `"TriG"`, `"N-Triples"`,
   * `"N-Quads"`). Defaults to Turtle/TriG.
   */
  readonly format?: string;
  /** Prefixes to declare in the serialized output. */
  readonly prefixes?: Record<string, string>;
}

/** Serialize quads back into a Turtle-family document. */
export function writeTurtle(
  quads: Quad[],
  options?: WriteTurtleOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({
      format: options?.format,
      prefixes: options?.prefixes,
    });
    writer.addQuads(quads);
    writer.end((error, result) => (error ? reject(error) : resolve(result)));
  });
}
