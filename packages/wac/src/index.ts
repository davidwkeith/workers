/**
 * `@dwk/wac` — Web Access Control (WAC) evaluation for Solid Pods.
 *
 * @remarks
 * Pure library: takes ACL graphs and request facts as plain data and returns an
 * authorization decision. Tied to the Solid/WAC model by design, but carries no
 * Cloudflare bindings and is unit-testable without a Workers runtime.
 *
 * The evaluator performs the effective-ACL walk (resolving the nearest
 * applicable `.acl`, honoring `acl:default` on ancestor containers), evaluates
 * `acl:Read`, `acl:Write`, `acl:Append`, and `acl:Control`, and supports
 * `acl:agent`, `acl:agentGroup`, `acl:agentClass` (including `foaf:Agent` and
 * `acl:AuthenticatedAgent`), and `acl:origin`.
 *
 * Callers MUST NOT memoize decisions in eventually-consistent stores; the walk
 * is cheap and is meant to run against strongly-consistent ACL state.
 *
 * @see {@link https://solidproject.org/TR/wac | Solid WAC specification}
 * @packageDocumentation
 */

import type { StoredTerm } from "@dwk/rdf";

/**
 * A plain RDF triple for ACL evaluation.
 *
 * @remarks
 * Subject and predicate are always IRIs; the object may be an IRI (named node)
 * shorthand string or a full {@link StoredTerm} from `@dwk/rdf`. WAC only
 * matches named-node objects, so literals and blank nodes never match.
 */
export interface AclQuad {
  /** Subject IRI. */
  subject: string;
  /** Predicate IRI. */
  predicate: string;
  /** Object: an IRI string, or a `@dwk/rdf` term. */
  object: string | StoredTerm;
}

/** WAC vocabulary base IRI. */
const ACL = "http://www.w3.org/ns/auth/acl#";
/** `rdf:type`. */
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
/** `foaf:Agent` — the class of all agents (public access). */
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";

const ACL_AUTHORIZATION = `${ACL}Authorization`;
const ACL_ACCESS_TO = `${ACL}accessTo`;
const ACL_DEFAULT = `${ACL}default`;
/** Legacy alias for `acl:default`, still seen in the wild. */
const ACL_DEFAULT_FOR_NEW = `${ACL}defaultForNew`;
const ACL_AGENT = `${ACL}agent`;
const ACL_AGENT_GROUP = `${ACL}agentGroup`;
const ACL_AGENT_CLASS = `${ACL}agentClass`;
const ACL_MODE = `${ACL}mode`;
const ACL_ORIGIN = `${ACL}origin`;
const ACL_AUTHENTICATED_AGENT = `${ACL}AuthenticatedAgent`;

const MODE_IRI: Record<AccessMode, string> = {
  read: `${ACL}Read`,
  write: `${ACL}Write`,
  append: `${ACL}Append`,
  control: `${ACL}Control`,
};

/**
 * An access mode that may be requested or granted.
 *
 * @remarks
 * `append` is implied by `write`: a request for `append` is satisfied by either
 * an `acl:Append` or an `acl:Write` grant. A delete (which is not insert-only)
 * MUST be requested as `write`, never `append`.
 */
export type AccessMode = "read" | "write" | "append" | "control";

/** How an ACL document's authorizations attach to a resource. */
export type AclScope = "accessTo" | "default";

/**
 * A single ACL document in the effective-ACL chain, as plain RDF quads.
 *
 * @remarks
 * The chain is ordered nearest-first: the requested resource's own ACL (with
 * {@link AclScope | scope} `"accessTo"`) comes first, followed by ancestor
 * container ACLs (scope `"default"`) from closest to farthest. **Only ACL
 * documents that exist (have a representation) are included.**
 *
 * Per WAC §5.1 the effective ACL is the *first* ancestor whose ACL resource
 * exists, "regardless of whether it contains matching authorizations". Because
 * every chain entry represents an existing ACL document, the **first entry is
 * the effective ACL and is authoritative**: {@link evaluateAccess} decides from
 * it alone — granted or denied — and never falls through (fail open) to a
 * farther ancestor's `acl:default`. Selecting *which* ancestor's ACL exists is
 * the caller's job; this library does not climb the hierarchy by inspecting
 * authorization content. Entries after the first are not consulted, so callers
 * SHOULD pass exactly the single effective ACL.
 */
export interface AclResource {
  /**
   * The IRI this ACL document governs: the requested resource for an
   * `accessTo` entry, or the container for a `default` entry. Authorizations
   * are matched against this IRI via the scope predicate.
   */
  target: string;
  /** Which predicate links authorizations in this document to {@link target}. */
  scope: AclScope;
  /** The ACL document's statements, consumed from `@dwk/rdf`. */
  quads: AclQuad[];
}

/** Facts about the agent and request being authorized. */
export interface AccessRequest {
  /** The requested access mode. */
  mode: AccessMode;
  /** The authenticated agent's WebID, if any. Absence means unauthenticated. */
  agent?: string;
  /** Group IRIs the agent is a member of, matched against `acl:agentGroup`. */
  groups?: string[];
  /** The request `Origin`, matched against `acl:origin` when present. */
  origin?: string;
}

/** The outcome of an authorization evaluation. */
export interface AccessDecision {
  /** Whether the requested mode is granted. */
  granted: boolean;
  /**
   * The modes granted to the agent by the effective ACL. Reports the modes
   * literally asserted (`acl:Read`/`Write`/`Append`/`Control`); note that a
   * `write` grant also satisfies an `append` request even when `append` is not
   * listed here.
   */
  modes: AccessMode[];
  /** The {@link AclResource.target} of the ACL that decided the request, if any. */
  effectiveAcl?: string;
}

/** A normalized authorization extracted from an ACL document. */
interface Authorization {
  subject: string;
  modes: string[];
  agents: string[];
  agentGroups: string[];
  agentClasses: string[];
  origins: string[];
}

/**
 * Returns the IRI of a quad object, or `undefined` if it is not a named node.
 *
 * Literals and blank nodes never match the named-node terms WAC cares about.
 */
function iri(object: AclQuad["object"]): string | undefined {
  if (typeof object === "string") {
    return object;
  }
  return object?.termType === "NamedNode" ? object.value : undefined;
}

/** Collects the named-node object IRIs for all `(subject, predicate, *)` quads. */
function collect(
  quads: AclQuad[],
  subject: string,
  predicate: string,
): string[] {
  const values: string[] = [];
  for (const q of quads) {
    if (q.subject === subject && q.predicate === predicate) {
      const value = iri(q.object);
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

/**
 * Finds the authorizations in an ACL document that apply to its scoped target.
 */
function findApplicableAuthorizations(acl: AclResource): Authorization[] {
  if (!acl || !acl.quads) {
    return [];
  }
  const { quads, scope, target } = acl;

  const subjects = new Set<string>();
  for (const q of quads) {
    if (q.predicate === RDF_TYPE && iri(q.object) === ACL_AUTHORIZATION) {
      subjects.add(q.subject);
    }
  }

  const authorizations: Authorization[] = [];
  for (const subject of subjects) {
    const scoped = quads.some((q) => {
      if (q.subject !== subject || iri(q.object) !== target) {
        return false;
      }
      if (scope === "accessTo") {
        return q.predicate === ACL_ACCESS_TO;
      }
      return q.predicate === ACL_DEFAULT || q.predicate === ACL_DEFAULT_FOR_NEW;
    });
    if (!scoped) {
      continue;
    }
    authorizations.push({
      subject,
      modes: collect(quads, subject, ACL_MODE),
      agents: collect(quads, subject, ACL_AGENT),
      agentGroups: collect(quads, subject, ACL_AGENT_GROUP),
      agentClasses: collect(quads, subject, ACL_AGENT_CLASS),
      origins: collect(quads, subject, ACL_ORIGIN),
    });
  }
  return authorizations;
}

/** Whether an authorization applies to the requesting agent. */
function agentMatches(auth: Authorization, request: AccessRequest): boolean {
  // `foaf:Agent` is the public class — everyone, authenticated or not.
  if (auth.agentClasses.includes(FOAF_AGENT)) {
    return true;
  }
  // A non-empty WebID means authenticated; an empty string is not a valid
  // identity and MUST NOT satisfy `acl:AuthenticatedAgent` or match a
  // (malformed) empty `acl:agent`.
  if (request.agent) {
    if (auth.agentClasses.includes(ACL_AUTHENTICATED_AGENT)) {
      return true;
    }
    if (auth.agents.includes(request.agent)) {
      return true;
    }
  }
  if (
    request.groups &&
    auth.agentGroups.some((g) => request.groups!.includes(g))
  ) {
    return true;
  }
  return false;
}

/**
 * Normalizes an origin to its `scheme://host[:port]` form so that comparisons
 * ignore case and trailing-slash differences. Falls back to the raw value when
 * it is not a parseable absolute URL, keeping the match fail-closed.
 */
function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/**
 * Whether an authorization's origin restriction admits the request.
 *
 * An authorization with no `acl:origin` applies regardless of origin; one with
 * origins acts as an allow-list. Both sides are normalized via {@link URL} so a
 * correctly-configured allow-list is not defeated by case or a trailing slash.
 */
function originMatches(auth: Authorization, request: AccessRequest): boolean {
  if (auth.origins.length === 0) {
    return true;
  }
  if (request.origin === undefined) {
    return false;
  }
  const requestOrigin = normalizeOrigin(request.origin);
  return auth.origins.some((o) => normalizeOrigin(o) === requestOrigin);
}

/** Whether the granted mode IRIs satisfy the requested mode. */
function isModeSatisfied(
  required: AccessMode,
  granted: ReadonlySet<string>,
): boolean {
  if (required === "append") {
    // Append authorizes insert-only patches and is implied by Write.
    return granted.has(MODE_IRI.append) || granted.has(MODE_IRI.write);
  }
  return granted.has(MODE_IRI[required]);
}

/** Maps the granted mode IRIs back to {@link AccessMode} values. */
function toAccessModes(granted: ReadonlySet<string>): AccessMode[] {
  return (Object.keys(MODE_IRI) as AccessMode[]).filter((mode) =>
    granted.has(MODE_IRI[mode]),
  );
}

/**
 * Evaluates a Web Access Control decision against an effective-ACL chain.
 *
 * @remarks
 * Per WAC §5.1 the effective ACL is the *first* ancestor whose ACL resource
 * exists, "regardless of whether it contains matching authorizations". The
 * {@link AclResource | chain} lists existing ACL documents nearest-first, so its
 * **first entry is the effective ACL and is authoritative**: the decision is
 * made from that document alone — granted or denied — and never falls through
 * (fail open) to a farther ancestor's `acl:default`, even when the document
 * grants nothing for the target. This holds equally for a resource's own `.acl`
 * (scope `"accessTo"`) and for an ancestor container's `acl:default`.
 *
 * Selecting *which* ancestor's ACL exists is the caller's responsibility (it is
 * a function of resource existence, not authorization content); this library
 * does not climb the hierarchy by inspecting authorizations, which would invert
 * §5.1's stop condition. Entries after the first are not consulted.
 *
 * @param request - The agent and request facts to authorize.
 * @param chain - The effective ACL as a one-element chain (nearest first).
 * @returns The decision, including the granted modes and the effective ACL.
 */
export function evaluateAccess(
  request: AccessRequest,
  chain: AclResource[],
): AccessDecision {
  if (!request || !chain || !Array.isArray(chain)) {
    return { granted: false, modes: [] };
  }
  // The first chain entry is an existing ACL document, hence the effective ACL
  // per §5.1; it is authoritative whether or not it carries a matching
  // authorization, so the decision is taken from it alone (fail closed).
  const acl = chain[0];
  if (!acl) {
    return { granted: false, modes: [] };
  }

  const granted = new Set<string>();
  for (const auth of findApplicableAuthorizations(acl)) {
    if (agentMatches(auth, request) && originMatches(auth, request)) {
      for (const mode of auth.modes) {
        granted.add(mode);
      }
    }
  }

  return {
    granted: isModeSatisfied(request.mode, granted),
    modes: toAccessModes(granted),
    effectiveAcl: acl.target,
  };
}
