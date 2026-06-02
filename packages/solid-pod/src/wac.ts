/**
 * Web Access Control enforcement: resolve the effective `.acl` for a resource
 * from the DO quad store, then defer the decision to `@dwk/wac`.
 *
 * The effective-ACL walk is the WAC algorithm: a resource's own `.acl`
 * (`acl:accessTo`) is authoritative when present; otherwise the nearest
 * ancestor container's `.acl` applies via `acl:default`. We read only the one
 * effective document and hand it to `@dwk/wac`, which performs the mode/agent
 * matching. ACL state lives in strongly-consistent DO SQLite, so no decision is
 * ever cached.
 */

import type { Store } from "@dwk/store";
import {
  evaluateAccess,
  type AccessDecision,
  type AccessRequest,
  type AclQuad,
  type AclResource,
} from "@dwk/wac";

import { aclPath, ancestorContainers, toIri } from "./ldp";

/** Map the store's quads for an ACL document into `@dwk/wac` input. */
function toAclQuads(store: Store, aclKey: string): AclQuad[] {
  return store.readQuads(aclKey).map((q) => ({
    subject: q.subject.value,
    predicate: q.predicate.value,
    object: q.object,
  }));
}

/**
 * Build the single effective ACL document for `path`, or `null` when no `.acl`
 * governs it anywhere up to the root (default-deny).
 */
function effectiveAcl(
  store: Store,
  origin: string,
  path: string,
): AclResource | null {
  const ownAcl = aclPath(path);
  if (store.head(ownAcl)) {
    return {
      target: toIri(origin, path),
      scope: "accessTo",
      quads: toAclQuads(store, ownAcl),
    };
  }
  for (const container of ancestorContainers(path)) {
    const containerAcl = aclPath(container);
    if (store.head(containerAcl)) {
      return {
        target: toIri(origin, container),
        scope: "default",
        quads: toAclQuads(store, containerAcl),
      };
    }
  }
  return null;
}

/**
 * Authorize a request against the effective ACL for `path`. Returns the
 * `@dwk/wac` decision; with no governing ACL the result is a default-deny.
 */
export function authorize(
  store: Store,
  origin: string,
  path: string,
  request: AccessRequest,
): AccessDecision {
  const acl = effectiveAcl(store, origin, path);
  if (acl === null) return { granted: false, modes: [] };
  return evaluateAccess(request, [acl]);
}
