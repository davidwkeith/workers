/**
 * RDF content negotiation for reads.
 *
 * Maps an `Accept` header to a concrete RDF serialization `@dwk/rdf` can write,
 * preferring the client's highest-q acceptable type and falling back to Turtle
 * (the Solid default). Turtle and JSON-LD are the guaranteed minimum; the other
 * Turtle-family types `@dwk/rdf` supports are offered too.
 */

import { formatForMediaType, type RdfFormat } from "@dwk/rdf";

/** A negotiated serialization: the concrete media type and `@dwk/rdf` format. */
export interface Negotiated {
  readonly mediaType: string;
  readonly format: RdfFormat;
}

/** Canonical media types offered on read, in server-preference order. */
const OFFERED: readonly string[] = [
  "text/turtle",
  "application/ld+json",
  "application/n-triples",
  "application/trig",
  "application/n-quads",
];

const DEFAULT: Negotiated = { mediaType: "text/turtle", format: "Turtle" };

interface AcceptEntry {
  readonly type: string;
  readonly q: number;
}

/** Parse an `Accept` header into entries sorted by descending q-value. */
function parseAccept(accept: string): AcceptEntry[] {
  return accept
    .split(",")
    .map((part) => {
      const [type, ...params] = part.split(";").map((s) => s.trim());
      let q = 1;
      for (const param of params) {
        const m = /^q=([0-9.]+)$/.exec(param);
        if (m) q = Number.parseFloat(m[1] as string);
      }
      return {
        type: (type ?? "").toLowerCase(),
        q: Number.isFinite(q) ? q : 0,
      };
    })
    .filter((e) => e.type.length > 0)
    .sort((a, b) => b.q - a.q);
}

/**
 * Choose the RDF serialization to write for an `Accept` header. Honors explicit
 * RDF media types and wildcards (`text/*`, `application/*`, and the catch-all
 * `*` `/` `*`); falls back to Turtle when nothing acceptable matches.
 */
export function negotiateMediaType(accept: string | null): Negotiated {
  if (!accept || accept.trim() === "") return DEFAULT;

  for (const entry of parseAccept(accept)) {
    if (entry.q === 0) continue;
    if (entry.type === "*/*") return DEFAULT;

    const essence = entry.type.split(";")[0]?.trim() ?? "";

    // Read-only opt-in: a client asking for `application/json` gets JSON-LD.
    // This alias lives here, not in `@dwk/rdf`'s RDF media-type registry, so an
    // incoming `application/json` *request body* is never misparsed as RDF.
    if (essence === "application/json") {
      return { mediaType: "application/ld+json", format: "JSON-LD" };
    }

    const format = formatForMediaType(entry.type);
    if (format) {
      return { mediaType: essence || "text/turtle", format };
    }

    // Wildcard subtypes (`text/*`, `application/*`): pick the first offered
    // type in that family.
    const slash = entry.type.indexOf("/");
    if (slash > 0 && entry.type.endsWith("/*")) {
      const family = entry.type.slice(0, slash);
      const offered = OFFERED.find((m) => m.startsWith(`${family}/`));
      if (offered) {
        return { mediaType: offered, format: formatForMediaType(offered)! };
      }
    }
  }

  return DEFAULT;
}
