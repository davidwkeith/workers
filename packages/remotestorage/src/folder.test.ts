import { describe, expect, it } from "vitest";

import type { ResourceMeta } from "@dwk/store";

import {
  buildFolderModel,
  FOLDER_DESCRIPTION_CONTEXT,
  hashSignature,
  renderFolderDescription,
} from "./folder";

function meta(
  key: string,
  etag: string,
  contentType = "text/plain",
): ResourceMeta {
  return { key, etag, contentType, kind: "blob" };
}

describe("buildFolderModel", () => {
  const entries: ResourceMeta[] = [
    meta("/documents/a.txt", '"e1"'),
    meta("/documents/b.txt", '"e2"', "application/json"),
    meta("/documents/sub/c.txt", '"e3"'),
    meta("/documents/sub/deep/d.txt", '"e4"'),
  ];

  it("splits immediate documents from subfolders, sorted by name", () => {
    const model = buildFolderModel("/documents/", entries);
    expect(model.documents.map((d) => d.name)).toEqual(["a.txt", "b.txt"]);
    expect(model.documents[1]).toMatchObject({
      name: "b.txt",
      etag: '"e2"',
      contentType: "application/json",
    });
    expect(model.subfolders.map((f) => f.name)).toEqual(["sub"]);
  });

  it("folds every descendant of a subfolder into its signature", () => {
    const model = buildFolderModel("/documents/", entries);
    const sub = model.subfolders[0]!;
    // Both c.txt and the deeper d.txt contribute to /documents/sub/'s signature.
    expect(sub.signature).toContain("/documents/sub/c.txt");
    expect(sub.signature).toContain("/documents/sub/deep/d.txt");
  });

  it("changes the folder signature when any descendant changes", () => {
    const before = buildFolderModel("/documents/", entries).signature;
    const mutated = entries.map((e) =>
      e.key === "/documents/sub/deep/d.txt" ? meta(e.key, '"e4-new"') : e,
    );
    const after = buildFolderModel("/documents/", mutated).signature;
    expect(after).not.toBe(before);
  });

  it("ignores entries outside the prefix", () => {
    const model = buildFolderModel("/documents/", [
      ...entries,
      meta("/photos/x.jpg", '"px"'),
    ]);
    expect(model.documents.some((d) => d.name === "x.jpg")).toBe(false);
    expect(model.signature).not.toContain("/photos/x.jpg");
  });

  it("models an empty folder with an empty signature", () => {
    const model = buildFolderModel("/empty/", []);
    expect(model.documents).toEqual([]);
    expect(model.subfolders).toEqual([]);
    expect(model.signature).toBe("");
  });
});

describe("hashSignature", () => {
  it("is stable and quoted, and differs for different signatures", async () => {
    const a = await hashSignature("x");
    expect(a).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await hashSignature("x")).toBe(a);
    expect(await hashSignature("y")).not.toBe(a);
  });
});

describe("renderFolderDescription", () => {
  it("emits the folder-description context, document Content-Types, and subfolder ETags", async () => {
    const model = buildFolderModel("/documents/", [
      meta("/documents/a.txt", '"e1"', "text/plain"),
      meta("/documents/sub/c.txt", '"e3"'),
    ]);
    const body = await renderFolderDescription(model);
    expect(body["@context"]).toBe(FOLDER_DESCRIPTION_CONTEXT);
    expect(body.items["a.txt"]).toEqual({
      ETag: "e1",
      "Content-Type": "text/plain",
    });
    // Subfolders carry a trailing slash and a bare aggregate ETag.
    const sub = body.items["sub/"];
    expect(sub).toBeDefined();
    expect(sub).not.toHaveProperty("Content-Type");
    expect((sub as { ETag: string }).ETag).toMatch(/^[0-9a-f]{64}$/);
  });
});
