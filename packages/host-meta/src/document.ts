/**
 * The host-meta document model (RFC 6415 §2): a host-wide set of top-level
 * `Link`s plus optional `Subject`/`Property` metadata. The model is a single
 * plain-data shape that **both** representations render from — the XRD
 * (`application/xrd+xml`) serializer in `xrd.ts` and the JRD
 * (`application/jrd+json`) serializer in `jrd.ts` — so the two are guaranteed
 * information-equivalent (RFC 6415 §3).
 *
 * The `Link` type is reused verbatim from `@dwk/webfinger`: host-meta links are
 * the same `rel`/`href`/`template`/`type`/`titles`/`properties` shape WebFinger
 * already defines, so the JRD link-shaping is shared and only the XRD serializer
 * is new (see the package spec).
 */

import type { Link } from "@dwk/webfinger";

export type { Link };

/**
 * A resolved host-meta document. `links` is always present (it is the point of
 * the document); `subject` and `properties` appear only when the operator
 * configured them. This is what both serializers consume.
 */
export interface HostMetaDocument {
  /** Optional subject the metadata describes — the host itself (XRD `Subject`). */
  readonly subject?: string;
  /** Optional host-level properties; a `null` value means "present but absent". */
  readonly properties?: Readonly<Record<string, string | null>>;
  /** The top-level link relations advertised for the host. */
  readonly links: readonly Link[];
}

/**
 * Build the `lrdd` `template` from a WebFinger endpoint URL. The Link-based
 * Resource Descriptor Document template is the URL clients expand with the
 * queried resource (`{uri}`) to reach per-account discovery (RFC 6415 §3,
 * RFC 7033 §10.1). If the supplied URL already contains a `{uri}` placeholder it
 * is used as-is; otherwise a `resource={uri}` query parameter is appended.
 */
export function lrddTemplate(webfingerUrl: string): string {
  if (webfingerUrl.includes("{uri}")) return webfingerUrl;
  const separator = webfingerUrl.includes("?") ? "&" : "?";
  return `${webfingerUrl}${separator}resource={uri}`;
}

/**
 * Assemble the host-meta {@link HostMetaDocument} from the operator's inputs.
 * When a WebFinger endpoint URL is supplied, an `lrdd` link templated to it is
 * emitted **first** (the relation fediverse/OpenID software probes for before
 * falling back to WebFinger), followed by any static operator-configured links.
 */
export function buildDocument(opts: {
  readonly webfingerUrl?: string;
  readonly links?: readonly Link[];
  readonly subject?: string;
  readonly properties?: Readonly<Record<string, string | null>>;
}): HostMetaDocument {
  const links: Link[] = [];
  if (opts.webfingerUrl !== undefined) {
    links.push({
      rel: "lrdd",
      type: "application/jrd+json",
      template: lrddTemplate(opts.webfingerUrl),
    });
  }
  if (opts.links) {
    links.push(...opts.links);
  }

  const document: {
    subject?: string;
    properties?: Readonly<Record<string, string | null>>;
    links: readonly Link[];
  } = { links };
  if (opts.subject !== undefined) {
    document.subject = opts.subject;
  }
  if (opts.properties && Object.keys(opts.properties).length > 0) {
    document.properties = opts.properties;
  }
  return document;
}
