import { describe, it, expect } from "vitest";
import {
  evaluateAccess,
  type AclQuad,
  type AclResource,
  type AccessRequest,
} from "./index.js";

const ACL = "http://www.w3.org/ns/auth/acl#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";

const RESOURCE = "https://alice.example/notes/secret.ttl";
const CONTAINER = "https://alice.example/notes/";
const ROOT = "https://alice.example/";
const ALICE = "https://alice.example/profile/card#me";
const BOB = "https://bob.example/profile/card#me";

/** Builds a named-node-only quad. */
function q(subject: string, predicate: string, object: string): AclQuad {
  return { subject, predicate, object };
}

/**
 * Builds the quads for one `acl:Authorization`.
 */
function authorization(
  subject: string,
  props: {
    accessTo?: string;
    default?: string;
    agents?: string[];
    agentGroups?: string[];
    agentClasses?: string[];
    modes?: string[];
    origins?: string[];
  },
): AclQuad[] {
  const quads: AclQuad[] = [q(subject, RDF_TYPE, `${ACL}Authorization`)];
  if (props.accessTo) quads.push(q(subject, `${ACL}accessTo`, props.accessTo));
  if (props.default) quads.push(q(subject, `${ACL}default`, props.default));
  for (const agent of props.agents ?? [])
    quads.push(q(subject, `${ACL}agent`, agent));
  for (const group of props.agentGroups ?? [])
    quads.push(q(subject, `${ACL}agentGroup`, group));
  for (const cls of props.agentClasses ?? [])
    quads.push(q(subject, `${ACL}agentClass`, cls));
  for (const mode of props.modes ?? [])
    quads.push(q(subject, `${ACL}mode`, mode));
  for (const origin of props.origins ?? [])
    quads.push(q(subject, `${ACL}origin`, origin));
  return quads;
}

function accessToAcl(quads: AclQuad[], target = RESOURCE): AclResource {
  // A resource's own ACL (scope "accessTo") is the effective ACL once it exists,
  // so it decides the request even when it grants nothing for the target.
  return { target, scope: "accessTo", quads };
}

function defaultAcl(quads: AclQuad[], target = CONTAINER): AclResource {
  return { target, scope: "default", quads };
}

describe("@dwk/wac evaluateAccess", () => {
  it("grants a mode to a named agent via acl:accessTo", () => {
    const acl = accessToAcl(
      authorization("#owner", {
        accessTo: RESOURCE,
        agents: [ALICE],
        modes: [`${ACL}Read`, `${ACL}Write`],
      }),
    );
    const request: AccessRequest = { mode: "read", agent: ALICE };
    const decision = evaluateAccess(request, acl);
    expect(decision.granted).toBe(true);
    expect(decision.effectiveAcl).toBe(RESOURCE);
    expect(decision.modes.sort()).toEqual(["read", "write"]);
  });

  it("denies a mode the agent was not granted", () => {
    const acl = accessToAcl(
      authorization("#reader", {
        accessTo: RESOURCE,
        agents: [ALICE],
        modes: [`${ACL}Read`],
      }),
    );
    expect(evaluateAccess({ mode: "write", agent: ALICE }, acl).granted).toBe(
      false,
    );
  });

  it("denies an agent who has no matching authorization", () => {
    const acl = accessToAcl(
      authorization("#owner", {
        accessTo: RESOURCE,
        agents: [ALICE],
        modes: [`${ACL}Read`],
      }),
    );
    const decision = evaluateAccess({ mode: "read", agent: BOB }, acl);
    expect(decision.granted).toBe(false);
    expect(decision.effectiveAcl).toBe(RESOURCE);
    expect(decision.modes).toEqual([]);
  });

  describe("agentClass", () => {
    it("grants public access via foaf:Agent regardless of authentication", () => {
      const acl = accessToAcl(
        authorization("#public", {
          accessTo: RESOURCE,
          agentClasses: [FOAF_AGENT],
          modes: [`${ACL}Read`],
        }),
      );
      expect(evaluateAccess({ mode: "read" }, acl).granted).toBe(true);
      expect(evaluateAccess({ mode: "read", agent: BOB }, acl).granted).toBe(
        true,
      );
    });

    it("grants acl:AuthenticatedAgent only to authenticated requests", () => {
      const acl = accessToAcl(
        authorization("#authed", {
          accessTo: RESOURCE,
          agentClasses: [`${ACL}AuthenticatedAgent`],
          modes: [`${ACL}Read`],
        }),
      );
      expect(evaluateAccess({ mode: "read", agent: BOB }, acl).granted).toBe(
        true,
      );
      expect(evaluateAccess({ mode: "read" }, acl).granted).toBe(false);
    });

    it("treats an empty-string agent as unauthenticated", () => {
      const authed = accessToAcl(
        authorization("#authed", {
          accessTo: RESOURCE,
          agentClasses: [`${ACL}AuthenticatedAgent`],
          modes: [`${ACL}Read`],
        }),
      );
      // An empty WebID is not an identity: it must not satisfy
      // acl:AuthenticatedAgent.
      expect(evaluateAccess({ mode: "read", agent: "" }, authed).granted).toBe(
        false,
      );

      // Nor should it match a malformed empty acl:agent value.
      const emptyAgent = accessToAcl(
        authorization("#empty", {
          accessTo: RESOURCE,
          agents: [""],
          modes: [`${ACL}Read`],
        }),
      );
      expect(
        evaluateAccess({ mode: "read", agent: "" }, emptyAgent).granted,
      ).toBe(false);
    });
  });

  describe("groups", () => {
    const GROUP = "https://alice.example/groups#editors";

    it("grants when the agent is a member of an acl:agentGroup", () => {
      const acl = accessToAcl(
        authorization("#editors", {
          accessTo: RESOURCE,
          agentGroups: [GROUP],
          modes: [`${ACL}Write`],
        }),
      );
      expect(
        evaluateAccess({ mode: "write", agent: BOB, groups: [GROUP] }, acl)
          .granted,
      ).toBe(true);
    });

    it("denies when the agent is not a member of the group", () => {
      const acl = accessToAcl(
        authorization("#editors", {
          accessTo: RESOURCE,
          agentGroups: [GROUP],
          modes: [`${ACL}Write`],
        }),
      );
      expect(
        evaluateAccess({ mode: "write", agent: BOB, groups: [] }, acl).granted,
      ).toBe(false);
    });
  });

  describe("origin", () => {
    const TRUSTED = "https://app.example";

    it("admits a request from a listed origin", () => {
      const acl = accessToAcl(
        authorization("#app", {
          accessTo: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Read`],
          origins: [TRUSTED],
        }),
      );
      expect(
        evaluateAccess({ mode: "read", agent: ALICE, origin: TRUSTED }, acl)
          .granted,
      ).toBe(true);
    });

    it("rejects a request from an unlisted origin", () => {
      const acl = accessToAcl(
        authorization("#app", {
          accessTo: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Read`],
          origins: [TRUSTED],
        }),
      );
      expect(
        evaluateAccess(
          { mode: "read", agent: ALICE, origin: "https://evil.example" },
          acl,
        ).granted,
      ).toBe(false);
      expect(evaluateAccess({ mode: "read", agent: ALICE }, acl).granted).toBe(
        false,
      );
    });

    it("normalizes origin for case and trailing-slash differences", () => {
      const acl = accessToAcl(
        authorization("#app", {
          accessTo: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Read`],
          origins: ["https://App.Example/"],
        }),
      );
      // A trailing slash and differing host case must not defeat the allow-list.
      expect(
        evaluateAccess(
          { mode: "read", agent: ALICE, origin: "https://app.example" },
          acl,
        ).granted,
      ).toBe(true);
    });

    it("ignores origin when the authorization sets none", () => {
      const acl = accessToAcl(
        authorization("#any", {
          accessTo: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Read`],
        }),
      );
      expect(
        evaluateAccess(
          { mode: "read", agent: ALICE, origin: "https://evil.example" },
          acl,
        ).granted,
      ).toBe(true);
    });
  });

  describe("effective-ACL walk", () => {
    it("inherits acl:default from an ancestor container when no nearer ACL applies", () => {
      const containerAcl = defaultAcl(
        authorization("#inherited", {
          default: CONTAINER,
          agents: [ALICE],
          modes: [`${ACL}Read`],
        }),
      );
      const decision = evaluateAccess(
        { mode: "read", agent: ALICE },
        containerAcl,
      );
      expect(decision.granted).toBe(true);
      expect(decision.effectiveAcl).toBe(CONTAINER);
    });

    it("treats the nearest existing ancestor default as authoritative, never climbing farther", () => {
      // This container ACL exists but its authorization scopes ROOT, not this
      // CONTAINER, so nothing applies — per WAC §5.1 a present-but-non-matching
      // ACL is still the effective ACL and is authoritative: the decision is a
      // fail-closed deny. The caller resolves and passes only this one
      // document; there is no farther, more-permissive root default to climb
      // to even if one existed (the inverted stop condition of issue #101) —
      // evaluateAccess's single-`AclResource` signature makes that structurally
      // impossible, not just behaviorally refused.
      const innerDefault: AclResource = {
        target: CONTAINER,
        scope: "default",
        quads: authorization("#wrong", {
          default: ROOT,
          agents: [ALICE],
          modes: [`${ACL}Write`],
        }),
      };
      const decision = evaluateAccess(
        { mode: "read", agent: ALICE },
        innerDefault,
      );
      expect(decision.granted).toBe(false);
      expect(decision.effectiveAcl).toBe(CONTAINER);
    });

    it("does not fall through an own-ACL that grants nothing (fail closed)", () => {
      // The resource's own ACL document exists but its authorization scopes a
      // different resource, so nothing applies to the target. As the effective
      // ACL it must deny rather than inherit a hypothetical permissive
      // container default (the issue #27 fail-open hazard) — there is no
      // container default passed here at all, since the caller would never
      // reach for one once its own ACL exists.
      const ownAcl = accessToAcl(
        authorization("#other", {
          accessTo: "https://alice.example/notes/other.ttl",
          agents: [ALICE],
          modes: [`${ACL}Write`],
        }),
      );
      const decision = evaluateAccess({ mode: "read", agent: ALICE }, ownAcl);
      expect(decision.granted).toBe(false);
      expect(decision.effectiveAcl).toBe(RESOURCE);
      expect(decision.modes).toEqual([]);
    });

    it("denies via an own-ACL carrying only acl:default entries", () => {
      // A malformed own-ACL that carries only acl:default (no acl:accessTo for
      // the target) still exists, so as the resource's own ACL it is implicitly
      // authoritative and must not fall through to the ancestor default.
      const ownAcl: AclResource = {
        target: RESOURCE,
        scope: "accessTo",
        quads: authorization("#mis-scoped", {
          default: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Write`],
        }),
      };
      const decision = evaluateAccess({ mode: "write", agent: ALICE }, ownAcl);
      expect(decision.granted).toBe(false);
      expect(decision.effectiveAcl).toBe(RESOURCE);
    });

    it("lets a resource's own ACL take precedence over an ancestor default", () => {
      // accessTo grants only Read; a container default would grant Write, but
      // the nearer applicable ACL is authoritative and the caller never passes
      // the farther one.
      const resourceAcl = accessToAcl(
        authorization("#own", {
          accessTo: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Read`],
        }),
      );
      expect(
        evaluateAccess({ mode: "read", agent: ALICE }, resourceAcl).granted,
      ).toBe(true);
      const write = evaluateAccess(
        { mode: "write", agent: ALICE },
        resourceAcl,
      );
      expect(write.granted).toBe(false);
      expect(write.effectiveAcl).toBe(RESOURCE);
    });

    it("honors acl:defaultForNew as an alias for acl:default", () => {
      const containerAcl = defaultAcl([
        q("#legacy", RDF_TYPE, `${ACL}Authorization`),
        q("#legacy", `${ACL}defaultForNew`, CONTAINER),
        q("#legacy", `${ACL}agent`, ALICE),
        q("#legacy", `${ACL}mode`, `${ACL}Read`),
      ]);
      expect(
        evaluateAccess({ mode: "read", agent: ALICE }, containerAcl).granted,
      ).toBe(true);
    });

    it("ignores an authorization-shaped subject with no rdf:type acl:Authorization (fail closed)", () => {
      // A subject carrying acl:accessTo/acl:agent/acl:mode but never declared
      // `rdf:type acl:Authorization` is not a candidate authorization, by
      // design (see findApplicableAuthorizations' doc comment): treating it as
      // one via structural inference would grant access based on a document
      // shape this library did not fully understand.
      const acl = accessToAcl([
        q("#untyped", `${ACL}accessTo`, RESOURCE),
        q("#untyped", `${ACL}agent`, ALICE),
        q("#untyped", `${ACL}mode`, `${ACL}Read`),
      ]);
      const decision = evaluateAccess({ mode: "read", agent: ALICE }, acl);
      expect(decision.granted).toBe(false);
      expect(decision.modes).toEqual([]);
    });

    it("denies via the effective ACL when its authorizations do not apply", () => {
      const root = defaultAcl(
        authorization("#root", {
          default: ROOT,
          agents: [ALICE],
          modes: [`${ACL}Read`],
        }),
        CONTAINER,
      );
      // The chain entry targets CONTAINER but the authorization defaults ROOT,
      // so nothing applies. The entry still exists, so per §5.1 it is the
      // effective ACL: the result is a fail-closed deny attributed to it.
      const decision = evaluateAccess({ mode: "read", agent: ALICE }, root);
      expect(decision.granted).toBe(false);
      expect(decision.effectiveAcl).toBe(CONTAINER);
      expect(decision.modes).toEqual([]);
    });

    it("denies with no effective ACL when the caller has none to pass", () => {
      // A caller that found no existing ACL anywhere up the hierarchy has
      // nothing to pass — this defensive branch covers that (and any other)
      // falsy call rather than throwing.
      const decision = evaluateAccess(
        { mode: "read", agent: ALICE },
        undefined as unknown as AclResource,
      );
      expect(decision.granted).toBe(false);
      expect(decision.effectiveAcl).toBeUndefined();
      expect(decision.modes).toEqual([]);
    });
  });

  describe("Append vs Write", () => {
    it("satisfies an append request from an acl:Append grant", () => {
      const acl = accessToAcl(
        authorization("#appender", {
          accessTo: RESOURCE,
          agents: [BOB],
          modes: [`${ACL}Append`],
        }),
      );
      expect(evaluateAccess({ mode: "append", agent: BOB }, acl).granted).toBe(
        true,
      );
    });

    it("satisfies an append request from an acl:Write grant (write implies append)", () => {
      const acl = accessToAcl(
        authorization("#writer", {
          accessTo: RESOURCE,
          agents: [ALICE],
          modes: [`${ACL}Write`],
        }),
      );
      expect(
        evaluateAccess({ mode: "append", agent: ALICE }, acl).granted,
      ).toBe(true);
    });

    it("does not satisfy a write (delete) request from an acl:Append grant", () => {
      const acl = accessToAcl(
        authorization("#appender", {
          accessTo: RESOURCE,
          agents: [BOB],
          modes: [`${ACL}Append`],
        }),
      );
      // A delete must be requested as `write`; Append-only must not authorize it.
      expect(evaluateAccess({ mode: "write", agent: BOB }, acl).granted).toBe(
        false,
      );
    });
  });

  it("evaluates acl:Control independently of read/write", () => {
    const acl = accessToAcl(
      authorization("#admin", {
        accessTo: RESOURCE,
        agents: [ALICE],
        modes: [`${ACL}Control`],
      }),
    );
    expect(evaluateAccess({ mode: "control", agent: ALICE }, acl).granted).toBe(
      true,
    );
    expect(evaluateAccess({ mode: "read", agent: ALICE }, acl).granted).toBe(
      false,
    );
  });

  it("unions modes across multiple matching authorizations in the effective ACL", () => {
    const acl = accessToAcl([
      ...authorization("#a", {
        accessTo: RESOURCE,
        agentClasses: [FOAF_AGENT],
        modes: [`${ACL}Read`],
      }),
      ...authorization("#b", {
        accessTo: RESOURCE,
        agents: [ALICE],
        modes: [`${ACL}Write`],
      }),
    ]);
    const decision = evaluateAccess({ mode: "write", agent: ALICE }, acl);
    expect(decision.granted).toBe(true);
    expect(decision.modes.sort()).toEqual(["read", "write"]);
  });

  it("accepts @dwk/rdf StoredTerm objects, ignoring non-named-node terms", () => {
    // Object given as a StoredTerm named node rather than a shorthand string.
    const acl: AclResource = {
      target: RESOURCE,
      scope: "accessTo",
      quads: [
        {
          subject: "#a",
          predicate: RDF_TYPE,
          object: { termType: "NamedNode", value: `${ACL}Authorization` },
        },
        {
          subject: "#a",
          predicate: `${ACL}accessTo`,
          object: { termType: "NamedNode", value: RESOURCE },
        },
        {
          subject: "#a",
          predicate: `${ACL}agent`,
          object: { termType: "NamedNode", value: ALICE },
        },
        {
          subject: "#a",
          predicate: `${ACL}mode`,
          object: { termType: "NamedNode", value: `${ACL}Read` },
        },
        // A literal object must never match a named-node lookup.
        {
          subject: "#a",
          predicate: `${ACL}mode`,
          object: { termType: "Literal", value: `${ACL}Write` },
        },
      ],
    };
    const decision = evaluateAccess({ mode: "read", agent: ALICE }, acl);
    expect(decision.granted).toBe(true);
    expect(decision.modes).toEqual(["read"]);
    expect(evaluateAccess({ mode: "write", agent: ALICE }, acl).granted).toBe(
      false,
    );
  });
});
