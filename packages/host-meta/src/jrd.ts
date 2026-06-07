/**
 * JRD (JSON Resource Descriptor) rendering of a host-meta document
 * (RFC 7033 §10.1, the `host-meta.json` variant of RFC 6415). The host-meta
 * `Link` objects are already the WebFinger JRD link shape — reused verbatim
 * from `@dwk/webfinger` — so rendering is just assembling the top-level members
 * and dropping any the document did not supply, mirroring `@dwk/webfinger`'s
 * `buildJrd`. The XRD serializer (`xrd.ts`) renders the *same* document model,
 * keeping the two representations information-equivalent.
 */

import type { HostMetaDocument, Link } from "./document";

/**
 * A fully-rendered host-meta JRD. `links` is always present (possibly empty);
 * `subject` and `properties` appear only when the document supplied them, so the
 * JSON stays minimal.
 */
export interface HostMetaJrd {
  /** The subject the metadata describes, when configured. */
  readonly subject?: string;
  /** Host-level properties, when configured. */
  readonly properties?: Readonly<Record<string, string | null>>;
  /** The top-level link set. */
  readonly links: readonly Link[];
}

/**
 * Shape a {@link HostMetaDocument} into its {@link HostMetaJrd} object: carry
 * through `subject`/`properties` only when present, and emit the links as-is
 * (they are already JRD-shaped). Exposed so callers can embed the JRD object
 * rather than re-parse the serialized string.
 */
export function buildHostMetaJrd(document: HostMetaDocument): HostMetaJrd {
  const jrd: {
    subject?: string;
    properties?: Readonly<Record<string, string | null>>;
    links: readonly Link[];
  } = { links: document.links };
  if (document.subject !== undefined) {
    jrd.subject = document.subject;
  }
  if (document.properties && Object.keys(document.properties).length > 0) {
    jrd.properties = document.properties;
  }
  return jrd;
}

/** Serialize a host-meta document to a JRD (`application/jrd+json`) body. */
export function serializeJrd(document: HostMetaDocument): string {
  return JSON.stringify(buildHostMetaJrd(document));
}
