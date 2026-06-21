import { describe, it, expect } from "vitest";
import {
  resolveOrigin,
  assertBindings,
  isReservedPath,
  InsecureBaseUrlError,
  MissingBindingError,
  type Mount,
} from "./config.js";

const noopHandler: Mount["handler"] = async () => new Response("ok");

describe("resolveOrigin", () => {
  it("accepts https and returns the origin", () => {
    expect(resolveOrigin("https://example.com/base")).toBe(
      "https://example.com",
    );
  });

  it("accepts http on localhost", () => {
    expect(resolveOrigin("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(resolveOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("rejects non-localhost http unless devMode", () => {
    expect(() => resolveOrigin("http://example.com")).toThrow(
      InsecureBaseUrlError,
    );
    expect(resolveOrigin("http://example.com", true)).toBe(
      "http://example.com",
    );
  });
});

describe("assertBindings", () => {
  const mounts: Mount[] = [
    {
      name: "@dwk/indieauth",
      handler: noopHandler,
      reservedPaths: ["/token"],
      requires: ["AUTH_DB", "TOKEN_SIGNING_KEY"],
    },
  ];

  it("passes when all required bindings are present", () => {
    expect(() =>
      assertBindings(mounts, { AUTH_DB: {}, TOKEN_SIGNING_KEY: "k" }),
    ).not.toThrow();
  });

  it("throws listing every missing binding", () => {
    try {
      assertBindings(mounts, { AUTH_DB: {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingBindingError);
      expect((err as MissingBindingError).missing).toEqual([
        { mount: "@dwk/indieauth", binding: "TOKEN_SIGNING_KEY" },
      ]);
    }
  });

  it("treats null as missing", () => {
    expect(() =>
      assertBindings(mounts, { AUTH_DB: null, TOKEN_SIGNING_KEY: "k" }),
    ).toThrow(MissingBindingError);
  });
});

describe("isReservedPath", () => {
  it("matches exact paths and subpaths, not unrelated prefixes", () => {
    const reserved = ["/.well-known/webfinger", "/media"];
    expect(isReservedPath("/.well-known/webfinger", reserved)).toBe(true);
    expect(isReservedPath("/media", reserved)).toBe(true);
    expect(isReservedPath("/media/abc123", reserved)).toBe(true);
    expect(isReservedPath("/mediator", reserved)).toBe(false);
    expect(isReservedPath("/about", reserved)).toBe(false);
  });
});
