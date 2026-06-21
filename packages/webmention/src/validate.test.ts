import { describe, it, expect } from "vitest";
import { validateWebmentionParams } from "./validate.js";

const baseUrl = "https://example.com";

describe("validateWebmentionParams", () => {
  it("accepts a valid source/target under the receiver's host", () => {
    const result = validateWebmentionParams({
      source: "https://other.example/post",
      target: "https://example.com/article",
      baseUrl,
    });
    expect(result).toEqual({
      ok: true,
      source: "https://other.example/post",
      target: "https://example.com/article",
    });
  });

  it("rejects a missing source", () => {
    const result = validateWebmentionParams({
      source: null,
      target: "https://example.com/article",
      baseUrl,
    });
    expect(result).toEqual({ ok: false, error: "missing_source" });
  });

  it("rejects a missing target", () => {
    const result = validateWebmentionParams({
      source: "https://other.example/post",
      target: "",
      baseUrl,
    });
    expect(result).toEqual({ ok: false, error: "missing_target" });
  });

  it("rejects a non-http(s) source", () => {
    const result = validateWebmentionParams({
      source: "javascript:alert(1)",
      target: "https://example.com/article",
      baseUrl,
    });
    expect(result).toEqual({ ok: false, error: "invalid_source" });
  });

  it("rejects an unparseable target", () => {
    const result = validateWebmentionParams({
      source: "https://other.example/post",
      target: "not a url",
      baseUrl,
    });
    expect(result).toEqual({ ok: false, error: "invalid_target" });
  });

  it("rejects source equal to target", () => {
    const result = validateWebmentionParams({
      source: "https://example.com/a",
      target: "https://example.com/a",
      baseUrl,
    });
    expect(result).toEqual({ ok: false, error: "source_equals_target" });
  });

  it("rejects a target on a foreign host", () => {
    const result = validateWebmentionParams({
      source: "https://other.example/post",
      target: "https://evil.example/article",
      baseUrl,
    });
    expect(result).toEqual({ ok: false, error: "target_not_supported" });
  });

  it("honors allowedHosts for multi-domain receivers", () => {
    const result = validateWebmentionParams({
      source: "https://other.example/post",
      target: "https://alt.example/article",
      baseUrl,
      allowedHosts: ["alt.example"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects every target when baseUrl is malformed", () => {
    const result = validateWebmentionParams({
      source: "https://other.example/post",
      target: "https://example.com/article",
      baseUrl: "not-a-url",
    });
    expect(result).toEqual({ ok: false, error: "target_not_supported" });
  });
});
