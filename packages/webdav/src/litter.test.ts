import { describe, expect, it } from "vitest";
import { isOsLitter } from "./litter.js";

describe("isOsLitter", () => {
  it("matches common OS sidecar files by basename", () => {
    expect(isOsLitter(".DS_Store")).toBe(true);
    expect(isOsLitter("/pod/photos/.DS_Store")).toBe(true);
    expect(isOsLitter("._resourcefork")).toBe(true);
    expect(isOsLitter("Thumbs.db")).toBe(true);
    expect(isOsLitter("desktop.ini")).toBe(true);
    expect(isOsLitter("/a/b/.Trashes")).toBe(true);
  });

  it("is case-insensitive for Windows litter", () => {
    expect(isOsLitter("THUMBS.DB")).toBe(true);
    expect(isOsLitter("Desktop.INI")).toBe(true);
  });

  it("does not match ordinary files", () => {
    expect(isOsLitter("note.ttl")).toBe(false);
    expect(isOsLitter("photo.jpg")).toBe(false);
    expect(isOsLitter("/pod/.well-known/profile")).toBe(false);
    expect(isOsLitter("DS_Store.txt")).toBe(false);
  });

  it("honours a custom pattern set", () => {
    expect(isOsLitter("keep.tmp", [/\.tmp$/])).toBe(true);
    expect(isOsLitter(".DS_Store", [/\.tmp$/])).toBe(false);
  });
});
