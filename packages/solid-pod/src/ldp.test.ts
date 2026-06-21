import { describe, expect, it } from "vitest";

import {
  aclPath,
  ancestorContainers,
  childKey,
  hasReservedAuxiliarySuffix,
  isAclPath,
  isContainer,
  parentContainer,
  resourceForAcl,
  toIri,
} from "./ldp.js";

describe("@dwk/solid-pod ldp helpers", () => {
  it("classifies containers and acl documents", () => {
    expect(isContainer("/a/")).toBe(true);
    expect(isContainer("/a/b")).toBe(false);
    expect(isAclPath("/a/b.acl")).toBe(true);
    expect(isAclPath("/a/b")).toBe(false);
  });

  it("maps a resource to its acl and back", () => {
    expect(aclPath("/a/b")).toBe("/a/b.acl");
    expect(aclPath("/a/")).toBe("/a/.acl");
    expect(resourceForAcl("/a/b.acl")).toBe("/a/b");
    expect(resourceForAcl("/a/.acl")).toBe("/a/");
  });

  it("walks parents and ancestors", () => {
    expect(parentContainer("/a/b/c")).toBe("/a/b/");
    expect(parentContainer("/a/b/")).toBe("/a/");
    expect(parentContainer("/x")).toBe("/");
    expect(parentContainer("/")).toBeNull();
    expect(ancestorContainers("/a/b/c")).toEqual(["/a/b/", "/a/", "/"]);
    expect(ancestorContainers("/")).toEqual([]);
  });

  it("builds absolute IRIs", () => {
    expect(toIri("https://pod.example", "/a/b")).toBe(
      "https://pod.example/a/b",
    );
  });

  it("derives child keys from a Slug, sanitizing unsafe characters", () => {
    expect(childKey("/c/", "note", false)).toBe("/c/note");
    expect(childKey("/c/", "my note!", false)).toBe("/c/my-note");
    expect(childKey("/c/", "sub", true)).toBe("/c/sub/");
    // No usable slug → a random (uuid-shaped) name.
    expect(childKey("/c/", null, false)).toMatch(/^\/c\/[0-9a-f-]{36}$/);
    expect(childKey("/c/", "  ", false)).toMatch(/^\/c\/[0-9a-f-]{36}$/);
  });

  it("never mints a reserved auxiliary resource from a Slug (issue #28)", () => {
    expect(hasReservedAuxiliarySuffix("evil.acl")).toBe(true);
    expect(hasReservedAuxiliarySuffix("evil.meta")).toBe(true);
    expect(hasReservedAuxiliarySuffix("evil")).toBe(false);
    // A Slug that would create an `.acl`/`.meta` falls back to a random name,
    // never the reserved key the client asked for.
    expect(childKey("/c/", "evil.acl", false)).toMatch(/^\/c\/[0-9a-f-]{36}$/);
    expect(childKey("/c/", "evil.meta", false)).toMatch(/^\/c\/[0-9a-f-]{36}$/);
    // A benign name with an inner dot is still honored.
    expect(childKey("/c/", "notes.txt", false)).toBe("/c/notes.txt");
  });
});
