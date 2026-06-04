/**
 * JSON Resource Descriptor (JRD) data model and the pure `rel`-filtering rule
 * from RFC 7033 §4.3. These types are plain data — no Workers runtime, no
 * Cloudflare bindings — so the discovery logic unit-tests in isolation. The
 * handler in `handler.ts` turns an HTTP request into a `resource` lookup and
 * renders the resulting {@link Jrd} as `application/jrd+json`.
 */

/**
 * A single link relation in a JRD (RFC 7033 §4.4.4). `rel` is required; the
 * remaining members are optional and emitted only when present. Either `href`
 * (a concrete target) or `template` (a URI template) typically carries the
 * link's value.
 */
export interface Link {
  /** The link relation type — a registered name or an absolute URI. */
  readonly rel: string;
  /** Media type of the target resource, when known. */
  readonly type?: string;
  /** The target URI. */
  readonly href?: string;
  /** Human-readable titles keyed by language tag (or `"und"`). */
  readonly titles?: Readonly<Record<string, string>>;
  /** Additional, scheme-defined properties; a `null` value means "absent". */
  readonly properties?: Readonly<Record<string, string | null>>;
  /** A URI template, used in place of `href` for parameterised links. */
  readonly template?: string;
}

/**
 * What the configured resource map (or {@link ResourceResolver}) yields for a
 * controlled resource. `subject` is optional here: the handler defaults it to
 * the queried `resource` URI (which is what Mastodon/fediverse clients require),
 * so a record normally lists only its `aliases`, `properties`, and `links`.
 */
export interface ResourceRecord {
  /** Overrides the echoed subject; defaults to the queried `resource` URI. */
  readonly subject?: string;
  /** Other URIs that identify the same entity (RFC 7033 §4.4.2). */
  readonly aliases?: readonly string[];
  /** Subject-level properties; a `null` value means "absent". */
  readonly properties?: Readonly<Record<string, string | null>>;
  /** The link relations advertised for this resource. */
  readonly links?: readonly Link[];
}

/**
 * A fully-rendered JRD as serialised in a `200` response. `subject` and `links`
 * are always present (`links` may be an empty array after `rel` filtering);
 * `aliases` and `properties` appear only when the record supplied them.
 */
export interface Jrd {
  /** The subject URI — equals the queried `resource` unless the record overrode it. */
  readonly subject: string;
  /** Other URIs identifying the subject. */
  readonly aliases?: readonly string[];
  /** Subject-level properties. */
  readonly properties?: Readonly<Record<string, string | null>>;
  /** The (possibly `rel`-filtered) link set. */
  readonly links: readonly Link[];
}

/**
 * Apply the RFC 7033 §4.3 `rel` filter: with no `rel` parameters the full link
 * set is returned; otherwise only links whose `rel` exactly matches one of the
 * requested relations survive. `rel` filtering never touches `aliases` or
 * subject `properties` — it scopes the `links` array only.
 */
export function filterLinksByRel(
  links: readonly Link[],
  rels: readonly string[],
): readonly Link[] {
  if (rels.length === 0) return links;
  return links.filter((link) => rels.includes(link.rel));
}

/**
 * Render the final {@link Jrd} for a matched resource: echo the queried
 * `resource` as the subject (unless the record overrides it), apply the `rel`
 * filter to the links, and carry through `aliases`/`properties` only when the
 * record actually supplied them (so the JSON stays minimal).
 */
export function buildJrd(
  resource: string,
  record: ResourceRecord,
  rels: readonly string[],
): Jrd {
  const jrd: {
    subject: string;
    aliases?: readonly string[];
    properties?: Readonly<Record<string, string | null>>;
    links: readonly Link[];
  } = {
    subject: record.subject ?? resource,
    links: filterLinksByRel(record.links ?? [], rels),
  };
  if (record.aliases && record.aliases.length > 0) {
    jrd.aliases = record.aliases;
  }
  if (record.properties && Object.keys(record.properties).length > 0) {
    jrd.properties = record.properties;
  }
  return jrd;
}
