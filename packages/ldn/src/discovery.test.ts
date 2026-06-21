import { describe, expect, it } from "vitest";

import type { StoredQuad } from "@dwk/rdf";

import {
  constrainedByLinkHeader,
  discoverInboxIris,
  inboxLinkHeader,
  inboxTriple,
  parseInboxLinks,
} from "./discovery.js";
import { LDP_CONSTRAINED_BY, LDP_INBOX } from "./vocab.js";

const named = (value: string) => ({ termType: "NamedNode" as const, value });
const graph = { termType: "DefaultGraph" as const, value: "" };

function quad(s: string, p: string, o: StoredQuad["object"]): StoredQuad {
  return { subject: named(s), predicate: named(p), object: o, graph };
}

describe("inboxLinkHeader", () => {
  it("builds an ldp:inbox Link value", () => {
    expect(inboxLinkHeader("https://alice.example/inbox/")).toBe(
      `<https://alice.example/inbox/>; rel="${LDP_INBOX}"`,
    );
  });
});

describe("constrainedByLinkHeader", () => {
  it("builds an ldp:constrainedBy Link value", () => {
    expect(constrainedByLinkHeader("https://alice.example/constraints")).toBe(
      `<https://alice.example/constraints>; rel="${LDP_CONSTRAINED_BY}"`,
    );
  });
});

describe("inboxTriple", () => {
  it("builds the <subject> ldp:inbox <inbox> triple", () => {
    expect(
      inboxTriple("https://alice.example/", "https://alice.example/inbox/"),
    ).toEqual({
      subject: named("https://alice.example/"),
      predicate: named(LDP_INBOX),
      object: named("https://alice.example/inbox/"),
      graph,
    });
  });
});

describe("discoverInboxIris", () => {
  const quads: StoredQuad[] = [
    quad("https://a.example/", LDP_INBOX, named("https://a.example/inbox/")),
    quad("https://a.example/", "http://x/p", named("https://a.example/other")),
    quad("https://b.example/", LDP_INBOX, named("https://b.example/inbox/")),
  ];

  it("returns the inbox for a given subject", () => {
    expect(discoverInboxIris(quads, "https://a.example/")).toEqual([
      "https://a.example/inbox/",
    ]);
  });

  it("returns every inbox object when no subject is given", () => {
    expect(discoverInboxIris(quads)).toEqual([
      "https://a.example/inbox/",
      "https://b.example/inbox/",
    ]);
  });

  it("ignores non-named-node inbox objects", () => {
    const literalInbox: StoredQuad = {
      subject: named("https://a.example/"),
      predicate: named(LDP_INBOX),
      object: { termType: "Literal", value: "not-an-iri" },
      graph,
    };
    expect(discoverInboxIris([literalInbox])).toEqual([]);
  });

  it("de-duplicates repeated inbox triples", () => {
    const dup = quad(
      "https://a.example/",
      LDP_INBOX,
      named("https://a.example/inbox/"),
    );
    expect(discoverInboxIris([dup, dup])).toEqual(["https://a.example/inbox/"]);
  });
});

describe("parseInboxLinks", () => {
  it("returns [] for an absent header", () => {
    expect(parseInboxLinks(null)).toEqual([]);
    expect(parseInboxLinks("")).toEqual([]);
  });

  it("parses the full ldp:inbox rel IRI", () => {
    const header = `<https://a.example/inbox/>; rel="${LDP_INBOX}"`;
    expect(parseInboxLinks(header)).toEqual(["https://a.example/inbox/"]);
  });

  it("accepts the bare `inbox` rel token", () => {
    expect(parseInboxLinks("<https://a.example/inbox/>; rel=inbox")).toEqual([
      "https://a.example/inbox/",
    ]);
  });

  it("matches inbox inside a multi-token rel", () => {
    const header = `<https://a.example/inbox/>; rel="alternate inbox"`;
    expect(parseInboxLinks(header)).toEqual(["https://a.example/inbox/"]);
  });

  it("ignores link-values whose rel is not the inbox", () => {
    const header = '<https://a.example/style.css>; rel="stylesheet"';
    expect(parseInboxLinks(header)).toEqual([]);
  });

  it("picks the inbox out of a multi-value header", () => {
    const header =
      '<https://a.example/meta>; rel="describedby", ' +
      `<https://a.example/inbox/>; rel="${LDP_INBOX}"`;
    expect(parseInboxLinks(header)).toEqual(["https://a.example/inbox/"]);
  });

  it("does not let a stray rel on one entry tag another entry's URI", () => {
    // A comma-separated rel="inbox" belongs only to its own <uri>.
    const header =
      '<https://a.example/not-inbox>; title="x", ' +
      `<https://a.example/inbox/>; rel="inbox"`;
    expect(parseInboxLinks(header)).toEqual(["https://a.example/inbox/"]);
  });

  it("is not fooled by `rel=inbox` inside a quoted parameter value", () => {
    const header = '<https://a.example/x>; title="rel=inbox"';
    expect(parseInboxLinks(header)).toEqual([]);
  });

  it("does not extract an inbox from inside a quoted parameter value", () => {
    // A comma followed by `<` inside a quoted `title` must not be mistaken for a
    // link-value boundary, or a title string could inject a phantom inbox.
    const header =
      "<https://a.example/doc>; " +
      'title="ignore, <https://evil.example/inbox/>; rel=inbox"';
    expect(parseInboxLinks(header)).toEqual([]);
  });

  it("parses a real inbox alongside a comma+bracket inside a quoted value", () => {
    const header =
      '<https://a.example/doc>; title="x, <y>", ' +
      `<https://a.example/inbox/>; rel="${LDP_INBOX}"`;
    expect(parseInboxLinks(header)).toEqual(["https://a.example/inbox/"]);
  });

  it("de-duplicates a repeated inbox URI", () => {
    const header =
      `<https://a.example/inbox/>; rel="${LDP_INBOX}", ` +
      `<https://a.example/inbox/>; rel="inbox"`;
    expect(parseInboxLinks(header)).toEqual(["https://a.example/inbox/"]);
  });

  it("skips malformed entries with no angle-bracketed URI", () => {
    expect(parseInboxLinks('rel="inbox"')).toEqual([]);
  });
});
