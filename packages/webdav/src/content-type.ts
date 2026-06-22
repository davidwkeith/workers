/**
 * Content-type inference for OS WebDAV clients — spec §3.
 *
 * Finder/Explorer routinely `PUT` files with a generic
 * `application/octet-stream` / `text/plain` or no `Content-Type` at all — which
 * would store a `.ttl` as an opaque blob instead of parsing it into the pod's
 * quad store. When the request type is missing or generic, infer from the file
 * extension before handing off to the pod's `PUT` path. An explicit, specific
 * client `Content-Type` always wins.
 */

/** Extension → MIME type. RDF surfaces first (they must reach the quad store). */
const EXTENSION_TYPES: Record<string, string> = {
  ttl: "text/turtle",
  nt: "application/n-triples",
  nq: "application/n-quads",
  trig: "application/trig",
  jsonld: "application/ld+json",
  rdf: "application/rdf+xml",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  ics: "text/calendar",
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  zip: "application/zip",
};

/** Types treated as non-specific, so extension inference is allowed to win. */
const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "text/plain",
  "application/x-www-form-urlencoded",
]);

/**
 * Resolve the content type to store a resource under.
 *
 * @param name The resource name or path (the extension is read from the tail).
 * @param declared The client's `Content-Type`, if any.
 * @returns The declared type when specific; otherwise the extension-inferred
 *   type; otherwise the declared (generic) type or `application/octet-stream`.
 */
export function inferContentType(
  name: string,
  declared?: string | null,
): string {
  const essence = (declared ?? "").split(";")[0]?.trim() ?? "";
  if (essence !== "" && !GENERIC_TYPES.has(essence.toLowerCase())) {
    return essence;
  }
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    const inferred = EXTENSION_TYPES[ext];
    if (inferred !== undefined) return inferred;
  }
  return essence !== "" ? essence : "application/octet-stream";
}
