import { describe, it, expect } from "vitest";
import {
  parsePageRequest,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "./pagination.js";

describe("parsePageRequest", () => {
  it("returns defaults when params are absent", () => {
    const params = new URLSearchParams();
    const result = parsePageRequest(params);
    expect(result.limit).toBe(DEFAULT_LIMIT);
    expect(result.offset).toBe(0);
  });

  it("parses valid limit and offset", () => {
    const params = new URLSearchParams({ limit: "20", offset: "40" });
    const result = parsePageRequest(params);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(40);
  });

  it("clamps limit to MAX_LIMIT", () => {
    const params = new URLSearchParams({ limit: "200" });
    const result = parsePageRequest(params);
    expect(result.limit).toBe(MAX_LIMIT);
  });

  it("falls back to default limit for zero", () => {
    const params = new URLSearchParams({ limit: "0" });
    const result = parsePageRequest(params);
    expect(result.limit).toBe(DEFAULT_LIMIT);
  });

  it("falls back to default limit for negative", () => {
    const params = new URLSearchParams({ limit: "-5" });
    const result = parsePageRequest(params);
    expect(result.limit).toBe(DEFAULT_LIMIT);
  });

  it("falls back to default limit for non-numeric", () => {
    const params = new URLSearchParams({ limit: "abc" });
    const result = parsePageRequest(params);
    expect(result.limit).toBe(DEFAULT_LIMIT);
  });

  it("falls back to offset 0 for negative", () => {
    const params = new URLSearchParams({ offset: "-10" });
    const result = parsePageRequest(params);
    expect(result.offset).toBe(0);
  });

  it("falls back to offset 0 for non-numeric", () => {
    const params = new URLSearchParams({ offset: "xyz" });
    const result = parsePageRequest(params);
    expect(result.offset).toBe(0);
  });

  it("allows offset of zero", () => {
    const params = new URLSearchParams({ offset: "0" });
    const result = parsePageRequest(params);
    expect(result.offset).toBe(0);
  });

  it("handles large valid offset", () => {
    const params = new URLSearchParams({ offset: "10000" });
    const result = parsePageRequest(params);
    expect(result.offset).toBe(10000);
  });

  it("handles decimal limit (truncates to integer)", () => {
    const params = new URLSearchParams({ limit: "20.9" });
    const result = parsePageRequest(params);
    expect(result.limit).toBe(DEFAULT_LIMIT);
  });
});
