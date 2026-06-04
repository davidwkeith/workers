import { describe, it, expect } from "vitest";

import { buildJrd, filterLinksByRel, type Link } from "./jrd";

const profile: Link = {
  rel: "http://webfinger.net/rel/profile-page",
  type: "text/html",
  href: "https://example.com/",
};
const self: Link = {
  rel: "self",
  type: "application/activity+json",
  href: "https://example.com/users/alice",
};
const avatar: Link = {
  rel: "http://webfinger.net/rel/avatar",
  href: "https://example.com/avatar.png",
};

describe("filterLinksByRel", () => {
  it("returns every link when no rel filters are given", () => {
    const links = [profile, self, avatar];
    expect(filterLinksByRel(links, [])).toEqual(links);
  });

  it("keeps only links whose rel matches a requested relation", () => {
    expect(filterLinksByRel([profile, self, avatar], ["self"])).toEqual([self]);
  });

  it("matches each of several repeated rel parameters", () => {
    expect(
      filterLinksByRel(
        [profile, self, avatar],
        ["self", "http://webfinger.net/rel/avatar"],
      ),
    ).toEqual([self, avatar]);
  });

  it("returns an empty array when no link matches the requested rel", () => {
    expect(filterLinksByRel([profile, self], ["nonexistent"])).toEqual([]);
  });

  it("matches rel exactly (case-sensitive, no substring match)", () => {
    expect(filterLinksByRel([self], ["SELF"])).toEqual([]);
    expect(filterLinksByRel([self], ["sel"])).toEqual([]);
  });
});

describe("buildJrd", () => {
  it("echoes the queried resource as the subject by default", () => {
    const jrd = buildJrd("acct:alice@example.com", { links: [self] }, []);
    expect(jrd.subject).toBe("acct:alice@example.com");
    expect(jrd.links).toEqual([self]);
  });

  it("lets a record override the subject", () => {
    const jrd = buildJrd(
      "acct:Alice@example.com",
      { subject: "acct:alice@example.com", links: [] },
      [],
    );
    expect(jrd.subject).toBe("acct:alice@example.com");
  });

  it("defaults links to an empty array when the record has none", () => {
    const jrd = buildJrd("acct:alice@example.com", {}, []);
    expect(jrd.links).toEqual([]);
  });

  it("applies the rel filter to the links", () => {
    const jrd = buildJrd(
      "acct:alice@example.com",
      { links: [profile, self, avatar] },
      ["self"],
    );
    expect(jrd.links).toEqual([self]);
  });

  it("carries aliases and properties through unaffected by rel filtering", () => {
    const jrd = buildJrd(
      "acct:alice@example.com",
      {
        aliases: ["https://example.com/users/alice"],
        properties: { "http://schema.org/name": "Alice" },
        links: [profile, self],
      },
      ["self"],
    );
    expect(jrd.aliases).toEqual(["https://example.com/users/alice"]);
    expect(jrd.properties).toEqual({ "http://schema.org/name": "Alice" });
    expect(jrd.links).toEqual([self]);
  });

  it("omits empty aliases and properties from the rendered JRD", () => {
    const jrd = buildJrd(
      "acct:alice@example.com",
      { aliases: [], properties: {}, links: [self] },
      [],
    );
    expect("aliases" in jrd).toBe(false);
    expect("properties" in jrd).toBe(false);
  });
});
