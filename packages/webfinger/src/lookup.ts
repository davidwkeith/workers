/**
 * The client half of WebFinger (RFC 7033 §4): resolve a fediverse handle
 * (`user@host`, `@user@host`, `!community@host`, `acct:user@host`) to the
 * actor IRI its home server advertises via the `self` link.
 *
 * Pure data with an **injected `fetch`** — this module builds the query URL
 * and parses/validates the JRD, but never makes a network call of its own.
 * Consumers own transport policy: the host is user-supplied, so callers MUST
 * wire an SSRF-guarded fetch (e.g. `@dwk/safe-fetch`, or `@dwk/activitypub`'s
 * guarded delivery fetch). Protocol-agnostic by design: the helper returns
 * links, interpreting them (Person vs Group, follow vs post) is the
 * consumer's job.
 *
 * @see spec/fediverse-interop.md §2.4 (community discovery)
 */

/** A parsed `user@host` handle. `user` keeps its case; `host` is lowercased. */
export interface ParsedHandle {
  readonly user: string;
  readonly host: string;
}

/** The AS2 media types a `self` link may carry for an ActivityPub actor. */
const ACTOR_LINK_TYPES = [
  "application/activity+json",
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
];

/**
 * Parse a fediverse handle into `user` + `host`. Accepts the bare
 * `user@host` form plus the common prefixes: `@user@host` (Mastodon),
 * `!community@host` (Lemmy), and `acct:user@host`. Returns `null` for
 * anything that is not exactly one non-empty user part and one valid
 * hostname — never throws.
 */
export function parseHandle(handle: string): ParsedHandle | null {
  let rest = handle.trim();
  if (rest.toLowerCase().startsWith("acct:")) rest = rest.slice(5);
  if (rest.startsWith("@") || rest.startsWith("!")) rest = rest.slice(1);
  const at = rest.indexOf("@");
  if (at <= 0 || at !== rest.lastIndexOf("@")) return null;
  const user = rest.slice(0, at);
  const host = rest.slice(at + 1).toLowerCase();
  if (user.length === 0 || host.length === 0) return null;
  if (/\s/.test(user) || user.includes("/")) return null;
  try {
    // Validate the host by round-tripping it through URL parsing; reject
    // anything URL parsing mangles or that smuggles a port/path/userinfo.
    const url = new URL(`https://${host}/`);
    if (url.hostname !== host || url.port !== "") return null;
  } catch {
    return null;
  }
  return { user, host };
}

/** The RFC 7033 query URL for a parsed handle (`resource=acct:user@host`). */
export function webfingerQueryUrl(handle: ParsedHandle): string {
  const resource = `acct:${handle.user}@${handle.host}`;
  return `https://${handle.host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
}

/**
 * Select the ActivityPub actor IRI from a fetched JRD: the `self` link whose
 * `type` is an AS2 media type. Liberal in what it accepts — a malformed JRD
 * or a missing link yields `null`, never an error.
 */
export function selectActorLink(jrd: unknown): string | null {
  if (!jrd || typeof jrd !== "object" || Array.isArray(jrd)) return null;
  const links = (jrd as Record<string, unknown>).links;
  if (!Array.isArray(links)) return null;
  for (const link of links) {
    if (!link || typeof link !== "object" || Array.isArray(link)) continue;
    const record = link as Record<string, unknown>;
    if (record.rel !== "self") continue;
    if (typeof record.href !== "string") continue;
    const type = record.type;
    if (
      typeof type === "string" &&
      ACTOR_LINK_TYPES.some((t) =>
        type.toLowerCase().startsWith(t.slice(0, 24)),
      )
    ) {
      return record.href;
    }
  }
  return null;
}

/** Options for {@link resolveHandle}. */
export interface ResolveHandleOptions {
  /**
   * Transport used for the single WebFinger `GET`. REQUIRED, and the caller
   * is responsible for SSRF guarding — the target host comes from the
   * untrusted handle.
   */
  readonly fetch: typeof globalThis.fetch;
  /** Timeout (ms) bounding the lookup. Defaults to 10 000. */
  readonly timeoutMs?: number;
}

/**
 * Resolve a handle to its ActivityPub actor IRI: parse, query
 * `/.well-known/webfinger` on the handle's host, and select the `self` actor
 * link. `null` on any failure (bad handle, unreachable host, non-2xx,
 * malformed JRD, no actor link) — never throws.
 */
export async function resolveHandle(
  handle: string,
  options: ResolveHandleOptions,
): Promise<string | null> {
  const parsed = parseHandle(handle);
  if (!parsed) return null;
  let response: Response;
  try {
    response = await options.fetch(webfingerQueryUrl(parsed), {
      headers: { accept: "application/jrd+json, application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let jrd: unknown;
  try {
    jrd = await response.json();
  } catch {
    return null;
  }
  return selectActorLink(jrd);
}
