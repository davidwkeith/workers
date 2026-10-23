import { describe, expect, it } from "vitest";

import {
  ACTOR_CONTEXT,
  AS2_CONTENT_TYPE,
  AS2_LD_CONTENT_TYPE,
  actorIri,
  as2ContentType,
  buildActorDocument,
  buildCollection,
  buildCollectionPage,
  objectId,
  objectType,
  wantsActivityJson,
  type ActorIris,
} from "./as2.js";

const IRIS: ActorIris = {
  id: "https://example.com/users/bob",
  inbox: "https://example.com/users/bob/inbox",
  outbox: "https://example.com/users/bob/outbox",
  followers: "https://example.com/users/bob/followers",
  following: "https://example.com/users/bob/following",
  keyId: "https://example.com/users/bob#main-key",
};

describe("buildActorDocument", () => {
  it("emits a Person with collections and an inline public key", () => {
    const doc = buildActorDocument(
      IRIS,
      {
        username: "bob",
        name: "Bob",
        summary: "hi",
        icon: "https://img/x.png",
      },
      "PEM",
    );
    expect(doc.type).toBe("Person");
    expect(doc.id).toBe(IRIS.id);
    expect(doc.preferredUsername).toBe("bob");
    expect(doc.inbox).toBe(IRIS.inbox);
    expect(doc.followers).toBe(IRIS.followers);
    expect(doc.summary).toBe("hi");
    expect(doc.icon).toEqual({ type: "Image", url: "https://img/x.png" });
    expect(doc.publicKey).toEqual({
      id: IRIS.keyId,
      owner: IRIS.id,
      publicKeyPem: "PEM",
    });
  });

  it("defaults name to the username and omits optional fields", () => {
    const doc = buildActorDocument(IRIS, { username: "bob" }, "PEM");
    expect(doc.name).toBe("bob");
    expect(doc.summary).toBeUndefined();
    expect(doc.icon).toBeUndefined();
    expect(doc.manuallyApprovesFollowers).toBe(false);
    expect(doc.endpoints).toBeUndefined();
  });

  it("advertises endpoints.sharedInbox when one is supplied", () => {
    const doc = buildActorDocument(IRIS, { username: "bob" }, "PEM", {
      sharedInbox: "https://example.com/inbox",
    });
    expect(doc.endpoints).toEqual({
      sharedInbox: "https://example.com/inbox",
    });
  });

  it("emits the FEP-2c59 webfinger back-link when supplied", () => {
    const doc = buildActorDocument(IRIS, { username: "bob" }, "PEM", {
      webfinger: "acct:bob@example.com",
    });
    expect(doc.webfinger).toBe("acct:bob@example.com");
  });

  it("emits the profile-page url when supplied and omits it otherwise", () => {
    const doc = buildActorDocument(IRIS, { username: "bob" }, "PEM", {
      url: "https://example.com/",
    });
    expect(doc.url).toBe("https://example.com/");
    expect(
      buildActorDocument(IRIS, { username: "bob" }, "PEM").url,
    ).toBeUndefined();
  });

  it("federates only the profile-preference flags that are set", () => {
    const doc = buildActorDocument(
      IRIS,
      { username: "bob", showFeatured: true, showRepliesInMedia: false },
      "PEM",
    );
    expect(doc.showFeatured).toBe(true);
    expect(doc.showRepliesInMedia).toBe(false);
    // An unset flag is omitted entirely rather than defaulted.
    expect(doc.showMedia).toBeUndefined();
    // A bare actor (no flags, no handle) carries none of these properties.
    const bare = buildActorDocument(IRIS, { username: "bob" }, "PEM");
    expect(bare.webfinger).toBeUndefined();
    expect(bare.showFeatured).toBeUndefined();
  });

  it("emits alsoKnownAs only when set and non-empty (#534)", () => {
    const doc = buildActorDocument(
      IRIS,
      {
        username: "bob",
        alsoKnownAs: ["https://xn--4t8h.dwk.io/users/dwk"],
      },
      "PEM",
    );
    expect(doc.alsoKnownAs).toEqual(["https://xn--4t8h.dwk.io/users/dwk"]);
    // Omitted entirely when unset, so an existing actor document stays
    // byte-for-byte unchanged.
    expect(
      buildActorDocument(IRIS, { username: "bob" }, "PEM").alsoKnownAs,
    ).toBeUndefined();
    // Also omitted when explicitly empty.
    expect(
      buildActorDocument(IRIS, { username: "bob", alsoKnownAs: [] }, "PEM")
        .alsoKnownAs,
    ).toBeUndefined();
  });

  it("defines alsoKnownAs in the actor @context as an @id-typed term (#534)", () => {
    const terms = ACTOR_CONTEXT[2] as Record<string, unknown>;
    expect(terms.alsoKnownAs).toEqual({
      "@id": "as:alsoKnownAs",
      "@type": "@id",
    });
  });

  it("federates profile fields as PropertyValue attachments, URLs as rel=me links", () => {
    const doc = buildActorDocument(
      IRIS,
      {
        username: "bob",
        fields: [
          { name: "Website", value: "https://dwk.io" },
          { name: "Blog", value: "https://pulletsforever.com/archive" },
          { name: "Pronouns", value: "he/<him>" },
        ],
      },
      "PEM",
    );
    expect(doc.attachment).toEqual([
      {
        type: "PropertyValue",
        name: "Website",
        value:
          '<a href="https://dwk.io/" rel="me nofollow noopener" target="_blank">dwk.io</a>',
      },
      {
        type: "PropertyValue",
        name: "Blog",
        value:
          '<a href="https://pulletsforever.com/archive" rel="me nofollow noopener" target="_blank">pulletsforever.com/archive</a>',
      },
      { type: "PropertyValue", name: "Pronouns", value: "he/&lt;him&gt;" },
    ]);
    // Names and values are trimmed; a URL's query and fragment stay in the
    // href but not the label; http: links too; any other scheme is text.
    expect(
      buildActorDocument(
        IRIS,
        {
          username: "bob",
          fields: [
            { name: " Site ", value: " http://example.com/a?b=1#c " },
            { name: "Mail", value: "mailto:bob@example.com" },
            { name: "X", value: 'javascript:alert("1")' },
          ],
        },
        "PEM",
      ).attachment,
    ).toEqual([
      {
        type: "PropertyValue",
        name: "Site",
        value:
          '<a href="http://example.com/a?b=1#c" rel="me nofollow noopener" target="_blank">example.com/a</a>',
      },
      { type: "PropertyValue", name: "Mail", value: "mailto:bob@example.com" },
      {
        type: "PropertyValue",
        name: "X",
        value: "javascript:alert(&quot;1&quot;)",
      },
    ]);
    const terms = ACTOR_CONTEXT[2] as Record<string, unknown>;
    expect(terms.PropertyValue).toBe("schema:PropertyValue");
    expect(terms.value).toBe("schema:value");
    // Omitted when unset or empty.
    expect(
      buildActorDocument(IRIS, { username: "bob" }, "PEM").attachment,
    ).toBeUndefined();
    expect(
      buildActorDocument(IRIS, { username: "bob", fields: [] }, "PEM")
        .attachment,
    ).toBeUndefined();
  });

  it("emits type Group when the profile declares it (#376)", () => {
    const doc = buildActorDocument(
      IRIS,
      { username: "birding", type: "Group" },
      "PEM",
    );
    expect(doc.type).toBe("Group");
  });
});

describe("collections", () => {
  it("a non-empty collection advertises first/last pages", () => {
    const col = buildCollection("https://c", 120, 50);
    expect(col.type).toBe("OrderedCollection");
    expect(col.totalItems).toBe(120);
    expect(col.first).toBe("https://c?page=1");
    expect(col.last).toBe("https://c?page=3");
  });

  it("an empty collection omits page links", () => {
    const col = buildCollection("https://c", 0, 50);
    expect(col.totalItems).toBe(0);
    expect(col.first).toBeUndefined();
  });

  it("a page links to the next page only while items remain", () => {
    const p1 = buildCollectionPage("https://c", 1, 2, 5, ["a", "b"]);
    expect(p1.type).toBe("OrderedCollectionPage");
    expect(p1.partOf).toBe("https://c");
    expect(p1.next).toBe("https://c?page=2");
    expect(p1.prev).toBeUndefined();

    const p3 = buildCollectionPage("https://c", 3, 2, 5, ["e"]);
    expect(p3.next).toBeUndefined();
    expect(p3.prev).toBe("https://c?page=2");
  });
});

describe("activity helpers", () => {
  it("reads object id from an IRI or nested object", () => {
    expect(objectId("https://x/1")).toBe("https://x/1");
    expect(objectId({ id: "https://x/2", type: "Note" })).toBe("https://x/2");
    expect(objectId(undefined)).toBeUndefined();
  });

  it("reads object type only from nested objects", () => {
    expect(objectType({ type: "Follow" })).toBe("Follow");
    expect(objectType("https://x/1")).toBeUndefined();
  });

  it("coerces an actor reference to its IRI", () => {
    expect(actorIri({ id: "https://a", type: "Person" })).toBe("https://a");
    expect(actorIri("https://a")).toBe("https://a");
  });
});

describe("wantsActivityJson", () => {
  it("detects AS2 / ld+json accept headers", () => {
    expect(wantsActivityJson("application/activity+json")).toBe(true);
    expect(
      wantsActivityJson(
        'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      ),
    ).toBe(true);
    expect(wantsActivityJson("text/html")).toBe(false);
    expect(wantsActivityJson(null)).toBe(false);
  });
});

describe("as2ContentType", () => {
  it("serves the ld+json profile variant only when negotiated for it", () => {
    expect(
      as2ContentType(
        'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      ),
    ).toBe(AS2_LD_CONTENT_TYPE);
  });

  it("falls back to activity+json for everyone else", () => {
    expect(as2ContentType("application/activity+json")).toBe(AS2_CONTENT_TYPE);
    expect(as2ContentType("text/html")).toBe(AS2_CONTENT_TYPE);
    expect(as2ContentType(null)).toBe(AS2_CONTENT_TYPE);
    // A client naming both prefers the fediverse activity+json alias.
    expect(
      as2ContentType("application/activity+json, application/ld+json"),
    ).toBe(AS2_CONTENT_TYPE);
  });
});
