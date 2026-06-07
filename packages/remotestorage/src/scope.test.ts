import { describe, expect, it } from "vitest";

import {
  authorizeScopes,
  isFolderPath,
  isPublicDocument,
  moduleForPath,
  parseScopes,
  ROOT_MODULE,
} from "./scope";

describe("parseScopes", () => {
  it("parses space-delimited module:mode entries", () => {
    expect(parseScopes("documents:rw photos:r")).toEqual([
      { module: "documents", mode: "rw" },
      { module: "photos", mode: "r" },
    ]);
  });

  it("supports the root wildcard module", () => {
    expect(parseScopes("*:rw")).toEqual([{ module: ROOT_MODULE, mode: "rw" }]);
  });

  it("drops malformed entries without failing the whole token", () => {
    // No colon, empty module, and an unknown mode are each skipped; the one
    // valid scope survives.
    expect(parseScopes("bogus :rw contacts:delete contacts:r")).toEqual([
      { module: "contacts", mode: "r" },
    ]);
  });

  it("treats an empty or absent scope claim as no scopes", () => {
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("   ")).toEqual([]);
  });
});

describe("isFolderPath / isPublicDocument", () => {
  it("recognises folders by their trailing slash", () => {
    expect(isFolderPath("/documents/")).toBe(true);
    expect(isFolderPath("/documents/a.txt")).toBe(false);
  });

  it("treats only non-folder paths under /public/ as public documents", () => {
    expect(isPublicDocument("/public/photos/cat.jpg")).toBe(true);
    expect(isPublicDocument("/public/photos/")).toBe(false); // folder listing
    expect(isPublicDocument("/photos/cat.jpg")).toBe(false); // private tree
  });
});

describe("moduleForPath", () => {
  it("returns the top-level folder name", () => {
    expect(moduleForPath("/documents/a.txt")).toBe("documents");
    expect(moduleForPath("/documents/")).toBe("documents");
  });

  it("sees through the /public/ prefix to the same module", () => {
    expect(moduleForPath("/public/documents/a.txt")).toBe("documents");
  });

  it("maps the vault root and the public root to the empty module", () => {
    expect(moduleForPath("/")).toBe("");
    expect(moduleForPath("/public/")).toBe("");
  });
});

describe("authorizeScopes", () => {
  const scopes = parseScopes("documents:rw photos:r");

  it("grants reads and writes within a read-write module", () => {
    expect(authorizeScopes(scopes, "/documents/a", false)).toBe(true);
    expect(authorizeScopes(scopes, "/documents/a", true)).toBe(true);
  });

  it("grants reads but denies writes in a read-only module", () => {
    expect(authorizeScopes(scopes, "/photos/a", false)).toBe(true);
    expect(authorizeScopes(scopes, "/photos/a", true)).toBe(false);
  });

  it("covers the matching module under the public tree", () => {
    expect(authorizeScopes(scopes, "/public/documents/a", true)).toBe(true);
    expect(authorizeScopes(scopes, "/public/photos/a", true)).toBe(false);
  });

  it("denies a module no scope mentions", () => {
    expect(authorizeScopes(scopes, "/contacts/a", false)).toBe(false);
  });

  it("lets the root wildcard reach every path including the vault root", () => {
    const root = parseScopes("*:rw");
    expect(authorizeScopes(root, "/anything/a", true)).toBe(true);
    expect(authorizeScopes(root, "/", false)).toBe(true);
  });

  it("denies the vault-root listing to a non-wildcard scope", () => {
    expect(authorizeScopes(scopes, "/", false)).toBe(false);
  });
});
