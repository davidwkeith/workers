/**
 * Representation selection for the one `/.well-known/host-meta` URL (RFC 6415
 * §3). The document is served as XRD (`application/xrd+xml`) **by default** and
 * as JRD (`application/jrd+json`) only when the client specifically prefers it,
 * via — in priority order — an explicit `?format=` override, the
 * `host-meta.json` path (RFC 7033 §10.1, always JRD), or a higher-q Accept
 * preference for JRD over XRD.
 */

/** The chosen representation. */
export type Format = "xrd" | "jrd";

/**
 * The best (highest) q-value among the given exact media types in an `Accept`
 * header, or `0` if none of them appear. Wildcards (`* /*`) are deliberately
 * ignored: they express no preference between XRD and JRD, so a bare `Accept:
 * * /*` (or a missing header) must fall through to the XRD default.
 */
function acceptQuality(accept: string, mediaTypes: readonly string[]): number {
  let best = 0;
  for (const part of accept.split(",")) {
    const segments = part.trim().split(";");
    const type = segments[0]?.trim().toLowerCase();
    if (type === undefined || !mediaTypes.includes(type)) continue;
    let q = 1;
    for (const segment of segments.slice(1)) {
      const match = /^\s*q=(.*)$/i.exec(segment);
      if (match && match[1] !== undefined) {
        const parsed = Number.parseFloat(match[1]);
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    if (q > best) best = q;
  }
  return best;
}

/**
 * Decide which representation to serve.
 *
 * 1. `?format=json`/`jrd` → JRD; `?format=xml`/`xrd` → XRD (explicit override
 *    wins over everything, per RFC 6415 §3's `?format=` mechanism).
 * 2. A request to the `host-meta.json` path → JRD (RFC 7033 §10.1).
 * 3. Otherwise compare Accept q-values: JRD only when it is *strictly*
 *    preferred over XRD; XRD is the default for ties, wildcards, and no header.
 */
export function negotiateFormat(
  url: URL,
  accept: string | null,
  isJsonPath: boolean,
): Format {
  const format = url.searchParams.get("format")?.toLowerCase();
  if (format === "json" || format === "jrd") return "jrd";
  if (format === "xml" || format === "xrd") return "xrd";

  if (isJsonPath) return "jrd";

  if (accept === null || accept.length === 0) return "xrd";
  const jrdQuality = acceptQuality(accept, [
    "application/jrd+json",
    "application/json",
  ]);
  const xrdQuality = acceptQuality(accept, ["application/xrd+xml"]);
  return jrdQuality > xrdQuality ? "jrd" : "xrd";
}
