/**
 * XRD (Extensible Resource Descriptor) rendering of a host-meta document — the
 * default `application/xrd+xml` representation of RFC 6415 §2. This is the only
 * serializer new to `@dwk/host-meta`: the JRD side reuses `@dwk/webfinger`'s
 * link shape. It renders the *same* {@link HostMetaDocument} the JRD serializer
 * does, so the two stay information-equivalent (RFC 6415 §3).
 *
 * Output maps the model onto the XRD 1.0 schema: `Subject`, `Property`
 * (`xsi:nil="true"` for an absent/`null` value), and `Link` elements with
 * `rel`/`type`/`href`/`template` attributes and nested `Title`/`Property`
 * children. All text and attribute values are XML-escaped.
 */

import type { HostMetaDocument, Link } from "./document";

/** The XRD 1.0 default namespace (OASIS). */
export const XRD_NAMESPACE = "http://docs.oasis-open.org/ns/xri/xrd-1.0";
/** The XML Schema instance namespace, used for `xsi:nil` on absent properties. */
const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

/**
 * Escape a string for inclusion in XML text or a double-quoted attribute value:
 * the five predefined entities. Applied to every dynamic value so operator- or
 * resource-supplied content can never break out of the document structure.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Whether any property (top-level or per-link) is `null`, requiring the `xsi` namespace. */
function needsXsi(document: HostMetaDocument): boolean {
  const hasNil = (props?: Readonly<Record<string, string | null>>): boolean =>
    props !== undefined && Object.values(props).some((v) => v === null);
  if (hasNil(document.properties)) return true;
  return document.links.some((link) => hasNil(link.properties));
}

/** Render a single `<Property>` element at the given indent. */
function propertyXml(
  type: string,
  value: string | null,
  indent: string,
): string {
  if (value === null) {
    return `${indent}<Property type="${escapeXml(type)}" xsi:nil="true"/>`;
  }
  return `${indent}<Property type="${escapeXml(type)}">${escapeXml(value)}</Property>`;
}

/** Render a single `<Link>` element, expanding to a child block only when it has titles/properties. */
function linkXml(link: Link): string[] {
  const attrs = [`rel="${escapeXml(link.rel)}"`];
  if (link.type !== undefined) attrs.push(`type="${escapeXml(link.type)}"`);
  if (link.href !== undefined) attrs.push(`href="${escapeXml(link.href)}"`);
  if (link.template !== undefined) {
    attrs.push(`template="${escapeXml(link.template)}"`);
  }
  const open = `  <Link ${attrs.join(" ")}`;

  const titles = link.titles ? Object.entries(link.titles) : [];
  const properties = link.properties ? Object.entries(link.properties) : [];
  if (titles.length === 0 && properties.length === 0) {
    return [`${open}/>`];
  }

  const lines = [`${open}>`];
  for (const [lang, title] of titles) {
    // RFC 7033 §4.4.4.3 uses "und" for an undetermined language; XRD omits the
    // attribute in that case rather than emitting `xml:lang="und"`.
    const langAttr = lang === "und" ? "" : ` xml:lang="${escapeXml(lang)}"`;
    lines.push(`    <Title${langAttr}>${escapeXml(title)}</Title>`);
  }
  for (const [type, value] of properties) {
    lines.push(propertyXml(type, value, "    "));
  }
  lines.push("  </Link>");
  return lines;
}

/** Serialize a host-meta document to an XRD (`application/xrd+xml`) body. */
export function serializeXrd(document: HostMetaDocument): string {
  const rootAttrs = needsXsi(document)
    ? `xmlns="${XRD_NAMESPACE}" xmlns:xsi="${XSI_NAMESPACE}"`
    : `xmlns="${XRD_NAMESPACE}"`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<XRD ${rootAttrs}>`,
  ];
  if (document.subject !== undefined) {
    lines.push(`  <Subject>${escapeXml(document.subject)}</Subject>`);
  }
  if (document.properties) {
    for (const [type, value] of Object.entries(document.properties)) {
      lines.push(propertyXml(type, value, "  "));
    }
  }
  for (const link of document.links) {
    lines.push(...linkXml(link));
  }
  lines.push("</XRD>");
  return lines.join("\n") + "\n";
}
