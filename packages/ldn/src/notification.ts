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
 *
 * Per LDN §3.3.1, a receiver SHOULD advertise the content types it accepts via
 * an `Accept-Post` header on `OPTIONS`. {@link acceptedContentTypes} and
 * {@link acceptPostHeader} build that advertisement from the same media-type
 * table {@link parseNotification} validates against, so the two cannot drift.
 */

import {
  parse as parseRdf,
  formatForMediaType,
  quadToStored,
  MEDIA_TYPE_FORMATS,
  type RdfFormat,
  type StoredQuad,
} from "@dwk/rdf";

/** Why a notification body was rejected. */
export type NotificationProblemCode = "unsupported_media_type" | "malformed";

/**
 * A rejected notification body, carrying the HTTP status an LDN receiver should
 * answer: `415` for a non-RDF / unknown media type, `400` for an RDF media type
 * whose body does not parse.
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
 * or when the body fails to parse (400). On success the triples are returned as
 * {@link StoredQuad}s ready to persist.
 *
 * A well-formed body that yields zero triples (an empty JSON-LD `@graph`, a bare
 * `@context`, a Turtle document of only prefix declarations) is **accepted**:
 * LDN §3.2 does not require a notification to carry at least one triple, so this
 * returns an empty `quads` array rather than rejecting it as malformed.
 */
export async function parseNotification(
  body: string,
  contentType: string | null,
  options: ParseNotificationOptions = {},
): Promise<ParsedNotification> {
  // Resolve the clean media type once (no parameters/casing) and reuse it for
  // both format lookup and parsing, consistent with the rest of the codebase.
  const mediaType = contentType
    ? (contentType.split(";")[0]?.trim().toLowerCase() ?? "")
    : "";
  const format = mediaType ? formatForMediaType(mediaType) : undefined;
  if (!format) {
    throw new NotificationProblem(
      "unsupported_media_type",
      `@dwk/ldn: notification media type "${contentType ?? ""}" is not a ` +
        `supported RDF serialization`,
    );
  }

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

  return { quads: quads.map(quadToStored), mediaType, format };
}

/**
 * The RDF media types {@link parseNotification} accepts, in registry order — the
 * value set an LDN receiver should advertise so senders pick a supported
 * serialization. Derived from `@dwk/rdf`'s `MEDIA_TYPE_FORMATS`, the same table
 * parsing validates against, so the advertisement and the validator never drift.
 */
export function acceptedContentTypes(): string[] {
  return Object.keys(MEDIA_TYPE_FORMATS);
}

/**
 * Build the `Accept-Post` header value (LDN §3.3.1) an LDN receiver should
 * answer on `OPTIONS`, advertising every content type {@link parseNotification}
 * accepts as a comma-separated list.
 */
export function acceptPostHeader(): string {
  return acceptedContentTypes().join(", ");
}
