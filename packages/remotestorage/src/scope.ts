/**
 * The remoteStorage authorization model as pure, runtime-free logic: OAuth
 * **scope** parsing, the module a storage path belongs to, and the read/write
 * access decision. No Workers runtime, no store, no token verification — so it
 * unit-tests in isolation and the front door and any future co-tenant share one
 * audited rule set.
 *
 * remoteStorage scopes are space-delimited `<module>:<mode>` entries (draft
 * §10): `mode` is `r` (read-only) or `rw` (read-write), and the module is a
 * top-level folder name, or `*` for the whole vault. A module scope `m` grants
 * access to both the private tree `/<m>/…` and the public tree `/public/<m>/…`.
 */

/** A granted access mode: read-only or read-write. */
export type ScopeMode = "r" | "rw";

/** A single parsed remoteStorage OAuth scope. */
export interface RemoteStorageScope {
  /** Top-level module (folder) name, or {@link ROOT_MODULE} for the whole vault. */
  readonly module: string;
  /** Whether the scope grants writes (`rw`) or reads only (`r`). */
  readonly mode: ScopeMode;
}

/** The wildcard module name granting access to the entire vault. */
export const ROOT_MODULE = "*";

/**
 * Parse a space-delimited OAuth `scope` string into remoteStorage scopes.
 * Malformed entries (no `:`, empty module, or a mode other than `r`/`rw`) are
 * dropped rather than failing the whole token, so an unrelated scope a client
 * also requested cannot deny access to a valid one.
 */
export function parseScopes(
  raw: string | undefined | null,
): RemoteStorageScope[] {
  if (!raw) return [];
  const scopes: RemoteStorageScope[] = [];
  for (const entry of raw.split(/\s+/)) {
    if (entry === "") continue;
    const colon = entry.lastIndexOf(":");
    if (colon <= 0) continue;
    const module = entry.slice(0, colon);
    const mode = entry.slice(colon + 1);
    if (mode !== "r" && mode !== "rw") continue;
    scopes.push({ module, mode });
  }
  return scopes;
}

/** Whether a request path targets a folder (the trailing-slash convention). */
export function isFolderPath(path: string): boolean {
  return path.endsWith("/");
}

/**
 * Whether a path is a **publicly readable document**: it lives under `/public/`
 * and is not itself a folder. Folder listings are never public, even under
 * `/public/` (draft §10), so a trailing-slash path returns `false`.
 */
export function isPublicDocument(path: string): boolean {
  return path.startsWith("/public/") && !isFolderPath(path);
}

/**
 * The top-level module a storage path belongs to, for scope matching. The
 * leading `/public/` segment is transparent — `/public/photos/x` and
 * `/photos/x` share the module `photos` — and the vault root (`/`, or
 * `/public/`) maps to the empty module, which only the {@link ROOT_MODULE}
 * (`*`) scope can reach.
 */
export function moduleForPath(path: string): string {
  let rel = path.replace(/^\/+/, "");
  if (rel === "public" || rel.startsWith("public/")) {
    rel = rel.slice("public".length).replace(/^\/+/, "");
  }
  const slash = rel.indexOf("/");
  return slash === -1 ? rel : rel.slice(0, slash);
}

/**
 * Decide whether the granted `scopes` permit the requested access to `path`.
 * `needWrite` selects read-vs-write: a write requires an `rw` scope, a read is
 * satisfied by either. A scope matches when its module equals the path's module
 * or is the `*` wildcard. The empty-module root (`/`) is reachable only via `*`.
 */
export function authorizeScopes(
  scopes: readonly RemoteStorageScope[],
  path: string,
  needWrite: boolean,
): boolean {
  const module = moduleForPath(path);
  for (const scope of scopes) {
    if (scope.module !== ROOT_MODULE && scope.module !== module) continue;
    if (needWrite && scope.mode !== "rw") continue;
    return true;
  }
  return false;
}
