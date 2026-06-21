import { describe, expect, it } from "vitest";

import type { StoredQuad } from "@dwk/rdf";

import { inboxListingQuads, listInboxMembers } from "./listing.js";
import { LDP_CONTAINER, LDP_CONTAINS, RDF_TYPE } from "./vocab.js";

const named = (value: string) => ({ termType: "NamedNode" as const, value });
const graph = { termType: "DefaultGraph" as const, value: "" };

describe("inboxListingQuads", () => {
  it("types the inbox as an ldp:Container and contains each member", () => {
    const quads = inboxListingQuads("https://a.example/inbox/", [
      "https://a.example/inbox/n1",
      "https://a.example/inbox/n2",
    ]);
    expect(quads).toEqual([
      {
        subject: named("https://a.example/inbox/"),
        predicate: named(RDF_TYPE),
        object: named(LDP_CONTAINER),
        graph,
      },
      {
        subject: named("https://a.example/inbox/"),
        predicate: named(LDP_CONTAINS),
        object: named("https://a.example/inbox/n1"),
        graph,
      },
      {
        subject: named("https://a.example/inbox/"),
        predicate: named(LDP_CONTAINS),
        object: named("https://a.example/inbox/n2"),
        graph,
      },
    ]);
  });

  it("emits just the container type for an empty inbox", () => {
    expect(inboxListingQuads("https://a.example/inbox/", [])).toHaveLength(1);
  });

  it("de-duplicates repeated members", () => {
    const quads = inboxListingQuads("https://a.example/inbox/", [
      "https://a.example/inbox/n1",
      "https://a.example/inbox/n1",
    ]);
    expect(quads).toHaveLength(2);
  });
});

describe("listInboxMembers", () => {
  const quads: StoredQuad[] = [
    {
      subject: named("https://a.example/inbox/"),
      predicate: named(RDF_TYPE),
      object: named(LDP_CONTAINER),
      graph,
    },
    {
      subject: named("https://a.example/inbox/"),
      predicate: named(LDP_CONTAINS),
      object: named("https://a.example/inbox/n1"),
      graph,
    },
    {
      subject: named("https://other.example/inbox/"),
      predicate: named(LDP_CONTAINS),
      object: named("https://other.example/inbox/n9"),
      graph,
    },
  ];

  it("reads members scoped to an inbox", () => {
    expect(listInboxMembers(quads, "https://a.example/inbox/")).toEqual([
      "https://a.example/inbox/n1",
    ]);
  });

  it("reads every contained member when unscoped", () => {
    expect(listInboxMembers(quads)).toEqual([
      "https://a.example/inbox/n1",
      "https://other.example/inbox/n9",
    ]);
  });

  it("round-trips with inboxListingQuads", () => {
    const members = [
      "https://a.example/inbox/n1",
      "https://a.example/inbox/n2",
    ];
    const built = inboxListingQuads("https://a.example/inbox/", members);
    expect(listInboxMembers(built, "https://a.example/inbox/")).toEqual(
      members,
    );
  });
});
