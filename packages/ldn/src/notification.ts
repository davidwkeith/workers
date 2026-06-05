/**
 * LDN receiver — notification validation.
 *
 * An LDN receiver accepts a `POST` of an RDF notification to an inbox. The body
 * MUST be a supported RDF serialization (LDN mandates JSON-LD; this also accepts
 * the Turtle family `@dwk/rdf` supports) and MUST parse. This module classifies
 * the two rejection cases an inbox owner needs to map to a status code —
 * `unsupported_media_type` (415) and `malformed` (400) — and otherwise returns
 * the parsed triples in the flat, storage-friendly `StoredQuad` shape. It stays
 * protocol-agnostic: authorization, dedup, and storage are the caller's concern.
 */

import {
  parse as parseRdf,
  formatForMediaType,
  quadToStored,
  type RdfFormat,
  type StoredQuad,
} from "@dwk/rdf";

/** Why a notification body was rejected. */
export type NotificationProblemCode = "unsupported_media_type" | "malformed";

/**
 * A rejected notification body, carrying the HTTP status an LDN receiver should
 * answer: `415` for a non-RDF / unknown media type, `400` for an RDF media type
 * whose body does not parse (or carries no triples).
 */
export class NotificationProblem extends Error {
  readonly code: NotificationProblemCode;
  readonly status: 415 | 400;

  constructor(code: NotificationProblemCode, message: string) {
    super(message);
    this.name = "NotificationProblem";
    this.code = code;
    this.status = code === "unsupported_media_type" ? 415 : 400;
  }
}

/** A validated notification: its triples plus the RDF format it arrived in. */
export interface ParsedNotification {
  readonly quads: StoredQuad[];
  readonly mediaType: string;
  readonly format: RdfFormat;
}

/** Options for {@link parseNotification}. */
export interface ParseNotificationOptions {
  /** Base IRI used to resolve relative IRIs in the notification body. */
  readonly baseIRI?: string;
}

/**
 * Validate and parse an LDN notification body. Throws a {@link NotificationProblem}
 * when the `Content-Type` is missing / not a supported RDF serialization (415),
 * or when the body fails to parse or contains no triples (400). On success the
 * triples are returned as {@link StoredQuad}s ready to persist.
 */
export async function parseNotification(
  body: string,
  contentType: string | null,
  options: ParseNotificationOptions = {},
): Promise<ParsedNotification> {
  const format = contentType ? formatForMediaType(contentType) : undefined;
  if (!format) {
    throw new NotificationProblem(
      "unsupported_media_type",
      `@dwk/ldn: notification media type "${contentType ?? ""}" is not a ` +
        `supported RDF serialization`,
    );
  }

  const mediaType =
    (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

  let quads;
  try {
    quads = await parseRdf(
      body,
      mediaType,
      options.baseIRI ? { baseIRI: options.baseIRI } : {},
    );
  } catch (error) {
    throw new NotificationProblem(
      "malformed",
      `@dwk/ldn: notification body is not valid ${format}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (quads.length === 0) {
    throw new NotificationProblem(
      "malformed",
      "@dwk/ldn: notification body contains no triples",
    );
  }

  return { quads: quads.map(quadToStored), mediaType, format };
}
