/**
 * Path and IRI helpers for the LDP resource/container model.
 *
 * Resources are keyed in the store by their URL pathname. Containers are the
 * keys that end in `/`; everything else is a plain resource. ACL documents
 * follow the Solid convention `<resource>.acl` (and `<container>.acl`). These
 * helpers are pure string math so they unit-test without a Workers runtime.
 */

/** Whether a store key denotes an LDP container (trailing slash). */
export function isContainer(path: string): boolean {
  return path.endsWith("/");
}

/** Whether a path is an ACL document (`*.acl`). */
export function isAclPath(path: string): boolean {
  return path.endsWith(".acl");
}

/** The ACL document path that governs `path` (`<path>.acl`). */
export function aclPath(path: string): string {
  return `${path}.acl`;
}

/** The resource an ACL document governs (`<resource>.acl` → `<resource>`). */
export function resourceForAcl(aclPathValue: string): string {
  return aclPathValue.slice(0, -".acl".length);
}

/**
 * The immediate parent container of `path`, or `null` for the root container.
 * `"/a/b"` → `"/a/"`, `"/a/b/"` → `"/a/"`, `"/"` → `null`.
 */
export function parentContainer(path: string): string | null {
  if (path === "/") return null;
  const trimmed = isContainer(path) ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "/" : trimmed.slice(0, slash + 1);
}

/**
 * The ancestor containers of `path`, nearest first, up to and including the
 * root container `"/"`.
 */
export function ancestorContainers(path: string): string[] {
  const ancestors: string[] = [];
  let current = parentContainer(path);
  while (current !== null) {
    ancestors.push(current);
    current = parentContainer(current);
  }
  return ancestors;
}

/** Resolve a store key to its absolute resource IRI under `origin`. */
export function toIri(origin: string, path: string): string {
  return `${origin}${path}`;
}

const SLUG_UNSAFE = /[^A-Za-z0-9._~-]+/g;

/**
 * Pick a child key for a `POST` to `container`, honoring a client `Slug` when
 * present and safe, and falling back to a random name. A trailing slash is
 * appended when the new resource is itself a container.
 */
export function childKey(
  container: string,
  slug: string | null,
  asContainer: boolean,
): string {
  const cleaned = slug
    ?.trim()
    .replace(SLUG_UNSAFE, "-")
    .replace(/^-+|-+$/g, "");
  const name = cleaned && cleaned.length > 0 ? cleaned : crypto.randomUUID();
  return `${container}${name}${asContainer ? "/" : ""}`;
}
